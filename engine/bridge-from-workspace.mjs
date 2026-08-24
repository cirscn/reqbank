#!/usr/bin/env node
// Monorepo / Grok 桥接入口：把仓根会话的 hook 事件转发到 Platform harness hooks。
// - 路径真源仍是 apps/platform/.codex/hooks/* 与 apps/platform/.agentdoc/harness
// - Grok 被动 hook 不消费 additionalContext，故将召回写入仓根 .grok/rules/platform-harness-recall.md
// - Codex 在仓根时透传 hookSpecificOutput JSON；cwd 位于 apps/platform/** 时 fail-open no-op（包内 hooks 唯一 owner）
// - 桥接层异常一律 fail-open（exit 0 + {}），与直连 platform finalize 的阻断契约不同
// 用法：node bridge-from-workspace.mjs <session-init|recall|critic|finalize>

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProjectRoot } from './lib/repo-paths.mjs';

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = getProjectRoot();
const WORKSPACE_ROOT = resolve(PLATFORM_ROOT, '../..');
const RULES_DIR = join(WORKSPACE_ROOT, '.grok', 'rules');
const RULES_FILE = join(RULES_DIR, 'platform-harness-recall.md');

const HOOK_FILES = {
  'session-init': 'session-init.mjs',
  recall: 'recall.mjs',
  critic: 'critic.mjs',
  finalize: 'finalize.mjs'
};

const firstDefined = (...values) => {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
};

const readStdin = async () => {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
};

const parseJson = (raw) => {
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { __parse_error: true, raw };
  }
};

/** Grok 权威信号是 GROK_* env；camelCase hookEventName 仅作 dry-run fallback。 */
const isGrokRuntime = (input) => {
  if (process.env.GROK_HOOK_EVENT || process.env.GROK_SESSION_ID || process.env.GROK_WORKSPACE_ROOT) {
    return true;
  }
  // 手工 dry-run：显式 camelCase 事件名且无 Codex snake_case 主字段
  if (input?.hookEventName && !input?.hook_event_name && !input?.tool_name && !input?.session_id) {
    return true;
  }
  return false;
};

const isPathInside = (root, candidate) => {
  const absRoot = resolve(root);
  const absCandidate = resolve(candidate);
  if (absCandidate === absRoot) {
    return true;
  }
  const rel = relative(absRoot, absCandidate);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
};

/** Codex 在 platform 包内会话时，仓根 bridge 让位给包内 hooks，避免双跑。 */
const shouldDeferToPlatformHooks = (input, cwd) => {
  if (isGrokRuntime(input)) {
    return false;
  }
  return isPathInside(PLATFORM_ROOT, cwd || process.cwd());
};

const normalizeToolName = (name) => {
  const value = String(name ?? '');
  if (!value) {
    return value;
  }
  if (/^(search_replace|Edit|Write|MultiEdit|write)$/i.test(value)) {
    return 'apply_patch';
  }
  return value;
};

const extractEditPaths = (toolInput) => {
  if (!toolInput || typeof toolInput !== 'object') {
    return [];
  }
  const candidates = [
    toolInput.file_path,
    toolInput.filePath,
    toolInput.path,
    toolInput.target_file,
    toolInput.targetFile
  ];
  if (Array.isArray(toolInput.paths)) {
    candidates.push(...toolInput.paths);
  }
  return candidates
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim());
};

/**
 * 将工具路径归一为 platform 相对路径；platform 外路径返回 null（不进入 critic）。
 */
const toPlatformRelativePath = (filePath, cwd) => {
  if (!filePath || typeof filePath !== 'string') {
    return null;
  }
  const trimmed = filePath.trim();
  if (!trimmed) {
    return null;
  }

  const base = cwd || WORKSPACE_ROOT;
  const absolute = resolve(base, trimmed);
  if (isPathInside(PLATFORM_ROOT, absolute)) {
    return relative(PLATFORM_ROOT, absolute).replaceAll('\\', '/');
  }

  // 仓根相对：apps/platform/...
  const monorepoMatch = trimmed.replace(/^\.\//, '').match(/^apps\/platform\/(.+)$/);
  if (monorepoMatch) {
    return monorepoMatch[1];
  }

  // 已是 platform 相对（src/... 等），且不在 monorepo 其它包
  if (!isAbsolute(trimmed) && !trimmed.startsWith('apps/') && !trimmed.startsWith('..')) {
    const asPlatform = resolve(PLATFORM_ROOT, trimmed.replace(/^\.\//, ''));
    if (isPathInside(PLATFORM_ROOT, asPlatform)) {
      return relative(PLATFORM_ROOT, asPlatform).replaceAll('\\', '/');
    }
  }

  return null;
};

const pushEditHunk = (chunks, oldText, newText, platformPath) => {
  if (oldText || newText) {
    chunks.push('@@');
    for (const line of String(oldText).split('\n')) {
      chunks.push(`-${line}`);
    }
    for (const line of String(newText).split('\n')) {
      chunks.push(`+${line}`);
    }
  } else {
    chunks.push('@@');
    chunks.push(`+ // bridge path-only edit: ${platformPath}`);
  }
};

const synthesizeApplyPatch = (toolInput, cwd) => {
  const paths = extractEditPaths(toolInput);
  if (!paths.length) {
    return typeof toolInput?.command === 'string'
      ? toolInput.command
      : JSON.stringify(toolInput ?? {});
  }

  const edits = Array.isArray(toolInput?.edits) ? toolInput.edits : null;
  const chunks = ['*** Begin Patch'];
  let wroteAny = false;

  for (const filePath of paths) {
    const platformPath = toPlatformRelativePath(filePath, cwd);
    if (!platformPath) {
      continue;
    }
    wroteAny = true;
    const absolutePath = join(PLATFORM_ROOT, platformPath);
    chunks.push(`*** Update File: ${absolutePath}`);

    if (edits?.length) {
      for (const edit of edits) {
        if (!edit || typeof edit !== 'object') {
          continue;
        }
        const oldText = firstDefined(edit.old_string, edit.oldString, '');
        const newText = firstDefined(edit.new_string, edit.newString, edit.content, '');
        pushEditHunk(chunks, oldText, newText, platformPath);
      }
    } else {
      const oldText = firstDefined(toolInput.old_string, toolInput.oldString, '');
      const newText = firstDefined(toolInput.new_string, toolInput.newString, toolInput.content, '');
      pushEditHunk(chunks, oldText, newText, platformPath);
    }
  }

  if (!wroteAny) {
    // 全部路径在 platform 外：返回空 patch，critic 将 skip
    return '*** Begin Patch\n*** End Patch';
  }

  chunks.push('*** End Patch');
  return chunks.join('\n');
};

const normalizeInput = (input, hookName) => {
  const cwd = firstDefined(input.cwd, input.workspaceRoot, process.env.GROK_WORKSPACE_ROOT, process.cwd());
  const sessionId = firstDefined(input.session_id, input.sessionId, process.env.GROK_SESSION_ID);
  const turnId = firstDefined(input.turn_id, input.turnId, input.promptId, input.prompt_id);
  const prompt = firstDefined(input.prompt, input.userPrompt, input.text, input.message, '');
  const toolNameRaw = firstDefined(input.tool_name, input.toolName, '');
  const toolInput = firstDefined(input.tool_input, input.toolInput, {});

  const normalized = {
    ...input,
    session_id: sessionId ?? null,
    turn_id: turnId ?? null,
    prompt,
    cwd,
    source: firstDefined(input.source, input.hookEventName, process.env.GROK_HOOK_EVENT, null)
  };

  if (hookName === 'critic') {
    const needsSynth =
      !String(toolInput?.command ?? '').includes('*** Begin Patch')
      || /^(search_replace|Edit|Write|MultiEdit|write)$/i.test(String(toolNameRaw));
    normalized.tool_name = 'apply_patch';
    normalized.tool_input = {
      ...(typeof toolInput === 'object' && toolInput ? toolInput : {}),
      command: needsSynth ? synthesizeApplyPatch(toolInput, cwd) : toolInput.command
    };
  } else if (toolNameRaw) {
    normalized.tool_name = normalizeToolName(toolNameRaw);
    normalized.tool_input = toolInput;
  }

  return normalized;
};

const runPlatformHook = (hookFile, payload) => {
  const hookPath = join(HOOK_DIR, hookFile);
  const result = spawnSync(process.execPath, [hookPath], {
    cwd: PLATFORM_ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 8 * 1024 * 1024
  });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    error: result.error
  };
};

const ensureRulesDir = () => {
  if (!existsSync(RULES_DIR)) {
    mkdirSync(RULES_DIR, { recursive: true });
  }
};

const readRulesSections = () => {
  if (!existsSync(RULES_FILE)) {
    return { session: '', recall: '', critic: '' };
  }
  const text = readFileSync(RULES_FILE, 'utf8');
  const getSection = (name) => {
    const match = text.match(new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`));
    return match ? match[1].trim() : '';
  };
  return {
    session: getSection('Session'),
    recall: getSection('Current turn recall'),
    critic: getSection('Critic')
  };
};

const writeRulesFile = ({ session, recall, critic }) => {
  ensureRulesDir();
  const lines = [
    '# Platform Harness Recall（桥接自动生成）',
    '',
    '> 由 monorepo 根 Grok 桥接写入；勿手改、勿提交。真源仍是 `apps/platform/.agentdoc/harness`。',
    '> 空召回表示本回合未命中业务 REQ/TC，或 prompt 被分类为非业务实现。',
    '> 项目 hooks 需 `/hooks-trust`；Grok 被动 hook 不注入 additionalContext，靠本 rules 文件带进上下文。',
    '> **并行会话 last-writer-wins**：多 Grok 会话共用本文件会互相覆盖。',
    '> Grok Stop **不能** hard-block（与 Codex 不对等）；同回合须手读本文件拿 ID。',
    '',
    '## Session',
    session?.trim() || '（尚无 SessionStart 摘要）',
    '',
    '## Current turn recall',
    recall?.trim() || '（本回合无业务召回命中）',
    '',
    '## Critic',
    critic?.trim() || '（无 deterministic conflict）',
    ''
  ];
  const content = lines.join('\n');
  const tmp = `${RULES_FILE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, RULES_FILE);
};

const extractAdditionalContext = (hookJson) => {
  if (!hookJson || typeof hookJson !== 'object') {
    return '';
  }
  return (
    hookJson?.hookSpecificOutput?.additionalContext
    || hookJson?.additionalContext
    || hookJson?.systemMessage
    || hookJson?.reason
    || ''
  );
};

const grokAck = (hookName) => {
  process.stdout.write(JSON.stringify({
    systemMessage: `Platform harness ${hookName} → .grok/rules/platform-harness-recall.md（请手读）`
  }));
};

const emitForGrok = (hookName, hookJson) => {
  const sections = readRulesSections();
  const context = extractAdditionalContext(hookJson);

  if (hookName === 'session-init' && context) {
    writeRulesFile({ ...sections, session: context });
    grokAck(hookName);
    return;
  }

  if (hookName === 'recall') {
    // 新 turn：替换 recall 并清空上一 turn 的 critic，避免 stale conflict
    writeRulesFile({
      session: sections.session,
      recall: context || '（本回合无业务召回命中）',
      critic: '（无 deterministic conflict）'
    });
    grokAck(hookName);
    return;
  }

  if (hookName === 'critic' && context) {
    writeRulesFile({ ...sections, critic: context });
    grokAck(hookName);
    return;
  }

  if (hookName === 'finalize' && hookJson?.decision === 'block') {
    writeRulesFile({
      ...sections,
      critic: [sections.critic, context].filter(Boolean).join('\n\n') || context
    });
    // Grok 不能 hard-block；仅写 rules + 短提示
    process.stdout.write(JSON.stringify({
      systemMessage: 'Platform harness finalize 检测到确定性冲突（Grok 侧仅写入 rules，不 hard-block）。请读 platform-harness-recall.md Critic 段。'
    }));
    return;
  }

  process.stdout.write('{}');
};

const main = async () => {
  const hookName = process.argv[2];
  const hookFile = HOOK_FILES[hookName];
  if (!hookFile) {
    process.stderr.write(`[harness-bridge] unknown hook: ${hookName}\n`);
    process.stdout.write('{}');
    process.exit(0);
  }

  const raw = await readStdin();
  const input = parseJson(raw);
  if (input.__parse_error) {
    process.stderr.write('[harness-bridge] stdin parse failed (fail-open)\n');
  }

  const cwd = firstDefined(input.cwd, input.workspaceRoot, process.env.GROK_WORKSPACE_ROOT, process.cwd());
  if (shouldDeferToPlatformHooks(input, cwd)) {
    // 包内 Codex hooks 已会跑；仓根 bridge 静默让位
    process.stdout.write('{}');
    process.exit(0);
  }

  const normalized = normalizeInput(input, hookName);
  const result = runPlatformHook(hookFile, normalized);

  if (result.stderr) {
    process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  }
  if (result.error) {
    process.stderr.write(`[harness-bridge] spawn failed: ${result.error.message}\n`);
    process.stdout.write('{}');
    process.exit(0);
  }

  const hookJson = result.stdout ? parseJson(result.stdout) : {};
  if (isGrokRuntime(input)) {
    emitForGrok(hookName, hookJson);
  } else {
    // Codex / 其它：原样透传 platform hook 输出（含 decision:block）
    process.stdout.write(result.stdout || '{}');
  }
};

main().catch((err) => {
  process.stderr.write(`[harness-bridge] fatal: ${err.message}\n`);
  process.stdout.write('{}');
  process.exit(0);
});
