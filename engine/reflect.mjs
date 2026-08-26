#!/usr/bin/env node
// reqbank reflect —— 违规→条款回流（P4「考古入金」的持续入金通道）。
// 聚合 learning-log 的重复模式生成条款建议，写 inbox/ 待人审：
//   - 同一条款反复冲突（≥2 次）→ 建议把守卫写成断言（## 断言）或补 TC
//   - 同一路径多次改动但零召回 → 建议初始化模块 harness
//   - Stop 拦截事件 → 冲突事件卡（条款 ID + turn 溯源）
// transcript 接线（B4）：--transcript <path> 时消费 agent 会话转录——
//   工具调用写过的文件若零召回 → 模块初始化建议；用户纠错发言（「不要/别用」）→ 条款候选证据。
// 用法：node reflect.mjs [--transcript <path>] [--min-conflicts 2] [--min-paths 3]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readLogLines } from './lib/learning-log.mjs';
import { readTranscriptToolCalls } from './lib/transcript.mjs';
import { repoPath } from './lib/repo-paths.mjs';

const parseArgs = (argv) => {
  const options = { transcript: null, minConflicts: 2, minPaths: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--transcript') {
      index += 1;
      options.transcript = argv[index];
    } else if (argv[index] === '--min-conflicts') {
      index += 1;
      options.minConflicts = Number(argv[index]) || 2;
    } else if (argv[index] === '--min-paths') {
      index += 1;
      options.minPaths = Number(argv[index]) || 3;
    }
  }
  return options;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const events = readLogLines();

  // 同一条款反复冲突
  const conflictCounts = new Map();
  const blockEvents = [];
  for (const event of events) {
    if (event.event === 'PostToolUse') {
      for (const id of event.conflict_ids ?? []) {
        conflictCounts.set(id, (conflictCounts.get(id) ?? 0) + 1);
      }
    }
    if (event.event === 'Stop' && event.decision === 'block') {
      blockEvents.push(event);
    }
  }
  const suggestions = [];
  for (const [id, count] of conflictCounts) {
    if (count >= options.minConflicts) {
      suggestions.push({
        kind: 'repeat-conflict',
        title: `条款 ${id} 已 ${count} 次判冲突`,
        advice: '守卫屡被触碰——把守卫 token 写成「## 断言」的 no-delete/forbid-add（写前拦截），或补一条能失败的 TC。'
      });
    }
  }

  // 同一路径多次零召回
  const zeroRecallPaths = new Map();
  for (const event of events) {
    if (event.event === 'PostToolUse' && event.skip_reason === 'no_strong_recall') {
      for (const path of event.recall_path_candidates ?? []) {
        zeroRecallPaths.set(path, (zeroRecallPaths.get(path) ?? 0) + 1);
      }
    }
  }
  for (const [path, count] of zeroRecallPaths) {
    if (count >= options.minPaths) {
      suggestions.push({
        kind: 'unregistered-path',
        title: `路径 ${path} 改动 ${count} 次零召回`,
        advice: '该区域不在任何模块命中路径内——初始化模块 harness，或登记进「待初始化高风险模块」。'
      });
    }
  }

  // transcript 接线（B4）：工具调用写过的零召回文件 + 用户纠错发言
  if (options.transcript && existsSync(options.transcript)) {
    const { calls } = readTranscriptToolCalls(options.transcript);
    const writtenFiles = new Set();
    for (const call of calls ?? []) {
      const args = call?.arguments ?? {};
      const filePath = args.file_path ?? args.path;
      if (typeof filePath === 'string' && filePath) {
        writtenFiles.add(filePath);
      }
    }
    const recalledFiles = new Set(events.flatMap((event) => event.recall_path_candidates ?? []));
    for (const file of writtenFiles) {
      const short = file.split('/').slice(-2).join('/');
      if (![...recalledFiles].some((r) => r.endsWith(short) || file.endsWith(r))) {
        suggestions.push({
          kind: 'transcript-unregistered',
          title: `会话转录：${short} 被编辑过但从未召回`,
          advice: '来自 transcript 的考古证据——考虑为该文件所属区域初始化模块。'
        });
      }
    }
    // 用户纠错发言（不要/别用…）：最朴素的条款候选
    try {
      for (const line of readFileSync(options.transcript, 'utf8').split('\n').filter(Boolean)) {
        try {
          const entry = JSON.parse(line);
          const text = typeof entry?.message?.content === 'string'
            ? entry.message.content
            : Array.isArray(entry?.content) ? entry.content.filter((c) => typeof c === 'string').join(' ') : '';
          const match = String(text).match(/(不要|不得|别用|不应该)[^。！!\n]{4,60}/);
          if (match) {
            suggestions.push({
              kind: 'user-correction',
              title: `用户纠错发言：${match[0].slice(0, 60)}`,
              advice: '用户在会话中的直接纠正——最真实的契约来源，人审后入库（confidence: inferred）。'
            });
            break; // 每次运行只取首条，避免刷屏
          }
        } catch {}
      }
    } catch {}
  }

  const inboxDir = repoPath('.agentdoc', 'harness', 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const cardsPath = repoPath('.agentdoc', 'harness', 'inbox', `reflect-${stamp}.md`);
  const blockLines = blockEvents.slice(-10).map((event) =>
    `- Stop 拦截（turn ${event.turn_id ?? '?'}）：${(event.issues ?? []).join('；').slice(0, 120)}`);
  const content = [
    `# reflect 回流（${stamp}）`,
    '',
    `> 建议 ${suggestions.length} 条、Stop 拦截 ${blockEvents.length} 次（最近 10 条事件卡见文末）。人审后落为 REQ/断言/模块登记。`,
    '',
    ...suggestions.map((s, i) => `${i + 1}. [${s.kind}] ${s.title}\n   → ${s.advice}`),
    '',
    ...(blockLines.length ? ['## 冲突事件卡', '', ...blockLines] : [])
  ].join('\n');
  const existing = existsSync(cardsPath) ? readFileSync(cardsPath, 'utf8') : '';
  writeFileSync(cardsPath, `${existing}${existing ? '\n\n' : ''}${content}\n`);
  process.stdout.write(`${JSON.stringify({ suggestions: suggestions.length, blocks: blockEvents.length, path: cardsPath })}\n`);
  process.stderr.write(`[reqbank reflect] ${suggestions.length} 条建议 → ${cardsPath}\n`);
};

main().catch((error) => {
  console.error(`[reqbank reflect] fatal: ${error.message}`);
  process.exit(0); // 回流是建议性操作：fail-open
});
