#!/usr/bin/env node
// PreToolUse hook（Claude Code）：写前断言拦截。
// PostToolUse critic 是事后审计；本钩子在 Edit/Write/MultiEdit 落盘**之前**跑断言层，
// 命中即 permissionDecision: deny——把「最贵的时点才拦截」提前到零成本时点。
// 无断言命中时输出空 JSON 退出（快路径，无网络、无 LLM）。
// 注意：Codex 协议无 PreToolUse 事件，本层仅 Claude 适配器注册（能力矩阵如实标注）。

import { matchPathPattern, recallByPaths } from './lib/harness-store.mjs';
import { runAssertionReview, ASSERTION_FEEDBACK } from './lib/assertions.mjs';
import { appendLog, appendPayloadSample, parseHookPayload, readHookStdin } from './lib/learning-log.mjs';
import { normalizeChangedFilePath, normalizeClaudeCodeEdit } from './lib/patch-diff.mjs';

const main = async () => {
  const raw = await readHookStdin();
  const { input, parseError } = parseHookPayload(raw);
  const payloadSample = appendPayloadSample({ event: 'PreToolUse', raw, input, parseError });
  if (parseError) {
    // 写前拦截对解析失败 fail-open：坏 payload 不应卡死编辑
    process.stdout.write(JSON.stringify({}));
    appendLog({
      event: 'PreToolUse', session_id: input.session_id ?? null, turn_id: input.turn_id ?? input.prompt_id ?? null,
      payload_sample: payloadSample, parse_error: parseError.message ?? null,
      gate_mode: 'observe', denied: false, assertion_hits: []
    });
    return;
  }

  const claudeEdit = normalizeClaudeCodeEdit(input);
  if (!claudeEdit) {
    process.stdout.write(JSON.stringify({}));
    appendLog({
      event: 'PreToolUse', session_id: input.session_id ?? null, turn_id: input.turn_id ?? input.prompt_id ?? null,
      payload_sample: payloadSample, parse_error: null,
      skip_reason: 'no_edit_shape', gate_mode: 'observe', denied: false, assertion_hits: []
    });
    return;
  }

  const filePaths = claudeEdit.filePaths.map((filePath) => normalizeChangedFilePath(filePath, { cwd: input.cwd ?? '' }));
  const diff = claudeEdit.text;
  const recalledReqs = recallByPaths(filePaths, { recordKind: 'req-only', moduleQuota: 2 });
  const hits = runAssertionReview({ diff, filePaths, recalledReqs, matchPathPattern });

  const denied = hits.length > 0;
  const output = denied
    ? {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: [
            'reqbank 条款断言拦截（写前）：',
            ...hits.slice(0, 4).map((hit) =>
              `- ${hit.record.scope}:${hit.record.id} ${hit.kind}:${hit.pattern} —— 命中行：${hit.matchedLine.slice(0, 80)}`
            ),
            `下一步：${ASSERTION_FEEDBACK[hits[0].kind]}`
          ].join('\n')
        }
      }
    : {};

  process.stdout.write(JSON.stringify(output));
  appendLog({
    event: 'PreToolUse',
    session_id: input.session_id ?? null,
    turn_id: input.turn_id ?? input.prompt_id ?? null,
    payload_sample: payloadSample,
    parse_error: null,
    recall_path_candidates: filePaths,
    recall_ids: recalledReqs.map((record) => `${record.scope}:${record.id}`),
    assertion_hits: hits.map((hit) => ({ id: `${hit.record.scope}:${hit.record.id}`, kind: hit.kind, pattern: hit.pattern, line: hit.matchedLine })),
    gate_mode: denied ? 'hard-block' : 'observe',
    denied
  });
};

main().catch((err) => {
  // 写前拦截 fail-open：任何引擎异常都不应卡死编辑（事后还有 critic/Stop 两层兜底）
  process.stderr.write(`[harness-hook pre-critic] fatal: ${err.message}\n`);
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
});
