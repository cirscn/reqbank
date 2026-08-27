#!/usr/bin/env node
// Kimi Code → reqbank 引擎适配器。
// 用法：node .harness/engine/kimi-hook.mjs <SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop>
//
// 引擎输出 Codex/Claude 形状（hookSpecificOutput.additionalContext / decision:"block"），
// Kimi 的原生语义不同，本适配器负责翻译：
// - SessionStart / UserPromptSubmit：Kimi 把纯文本 stdout 追加进上下文，故解包 additionalContext；
// - PreToolUse：Kimi 原生理解 hookSpecificOutput.permissionDecision JSON，pre-critic 输出原样直通；
// - PostToolUse：Kimi 侧 observation-only，stdout 不进上下文——critic 的「自动沉淀」提醒
//   无法直达模型，故暂存到 .agentdoc/harness/kimi-pending-nudge.md，
//   下次 UserPromptSubmit 时随召回一并注入并清空（补回 Kimi 缺失的提醒通道）；
// - Stop：Kimi 用 exit 2 + stderr reason 阻断，故翻译引擎的 decision:"block"。
// 全程 fail-open：任何异常静默 exit 0，绝不影响主流程。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoPath } from './lib/repo-paths.mjs';

const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));

const EVENT_MAP = {
  SessionStart: 'session-init.mjs',
  UserPromptSubmit: 'recall.mjs',
  PreToolUse: 'pre-critic.mjs',
  PostToolUse: 'critic.mjs',
  Stop: 'finalize.mjs'
};

const readStdin = async () => {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
};

const parseOutput = (stdout) => {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
};

const getContext = (output) => {
  const context = output?.hookSpecificOutput?.additionalContext;
  return typeof context === 'string' && context ? context : '';
};

// Kimi 的 Edit/Write 工具参数叫 path，引擎按 Claude 形状读 tool_input.file_path——
// 引擎 0.19.0 起已原生兼容 path，此处归一是对旧版引擎的兜底，双写无害。
const normalizePayload = (raw) => {
  try {
    const input = JSON.parse(raw);
    const toolInput = input?.tool_input;
    if (toolInput && typeof toolInput === 'object' && !toolInput.file_path && typeof toolInput.path === 'string') {
      toolInput.file_path = toolInput.path;
    }
    return JSON.stringify(input);
  } catch {
    return raw;
  }
};

const pendingNudgePath = () => repoPath('.agentdoc', 'harness', 'kimi-pending-nudge.md');

const stashNudge = (context) => {
  const target = pendingNudgePath();
  mkdirSync(dirname(target), { recursive: true });
  // 先读后写合并；并发会话 last-writer-wins，与 fail-open 语义一致。
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (existing.includes(context)) {
    return; // 同文件重复提醒已由引擎按文件去重；这里再兜一层完全相同文本
  }
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  writeFileSync(target, `${existing}${existing ? '\n' : ''}[${stamp}] ${context}\n`);
};

const drainNudges = () => {
  const target = pendingNudgePath();
  if (!existsSync(target)) {
    return '';
  }
  const staging = `${target}.draining`;
  try {
    renameSync(target, staging); // 先挪走再读，期间新写入不落丢
    const content = readFileSync(staging, 'utf8').trim();
    return content ? `\n[reqbank 暂存提醒——来自此前编辑后的 critic，请收尾前处理]\n${content}\n` : '';
  } catch {
    return '';
  }
};

const main = async () => {
  const event = process.argv[2];
  const script = EVENT_MAP[event];
  if (!script) {
    process.exit(0);
  }

  const raw = await readStdin();
  const result = spawnSync(process.execPath, [join(ENGINE_DIR, script)], {
    input: normalizePayload(raw),
    encoding: 'utf8',
    cwd: process.cwd(),
    timeout: event === 'Stop' ? 50_000 : 20_000
  });

  const stdout = result.stdout?.trim() ?? '';
  const output = stdout ? parseOutput(stdout) : null;

  if (event === 'Stop') {
    if (output?.decision === 'block' && output?.reason) {
      process.stderr.write(String(output.reason));
      process.exit(2);
    }
    process.exit(0);
  }

  if (event === 'PreToolUse') {
    // pre-critic 的 hookSpecificOutput.permissionDecision 形状 Kimi 原生支持，原样直通
    if (stdout) {
      process.stdout.write(stdout);
    }
    process.exit(0);
  }

  if (event === 'PostToolUse') {
    const nudge = getContext(output);
    if (nudge) {
      stashNudge(nudge);
    }
    process.exit(0); // observation-only，stdout 不会被 Kimi 消费
  }

  // SessionStart / UserPromptSubmit：additionalContext 解包为纯文本交给 Kimi 追加
  const parts = [getContext(output)];
  if (event === 'UserPromptSubmit') {
    parts.push(drainNudges());
  }
  const text = parts.filter(Boolean).join('\n');
  if (text) {
    process.stdout.write(text);
  }
  process.exit(0);
};

main().catch(() => process.exit(0));
