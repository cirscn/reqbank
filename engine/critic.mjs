#!/usr/bin/env node
// PostToolUse hook on apply_patch: classify changed-file related REQ/TC as
// covered / weak / conflict and inject context only for deterministic conflicts.

import { extractKeywords, recallByPaths } from './lib/harness-store.mjs';
import { formatCriticVerdict, runCriticReview, selectProhibitionCandidates } from './lib/critic-prompt.mjs';
import { applyLlmCritic } from './lib/llm-critic.mjs';
import { appendLog, appendPayloadSample, findEventsByTurn, parseHookPayload, readHookStdin } from './lib/learning-log.mjs';
import { extractChangedFilePaths, extractChangedLinesFromApplyPatch } from './lib/patch-diff.mjs';

const formatScopedId = (record) => `${record.scope}:${record.id}`;

const main = async () => {
  const raw = await readHookStdin();
  const { input, parseError } = parseHookPayload(raw);
  const payloadSample = appendPayloadSample({ event: 'PostToolUse', raw, input, parseError });
  if (parseError) {
    process.stderr.write(`[harness-hook critic] stdin parse failed: ${parseError.message}\n`);
  }

  const turnId = input.turn_id ?? null;
  const toolInput = input.tool_input ?? {};
  const rawDiff = toolInput.command ?? '';
  const diff = extractChangedLinesFromApplyPatch(rawDiff);

  // PostToolUse 自主召回：不依赖 UserPromptSubmit 的关键词召回结果（容易伪召回 / classifyPromptKind 失灵），
  // 而是从本次 patch 实际改动的文件路径出发，按模块 strong 路径召回 REQ/TC。
  const filePaths = extractChangedFilePaths(rawDiff, { cwd: input.cwd ?? '' });
  const recalledReqs = recallByPaths(filePaths, { keywords: extractKeywords(diff) });

  if (recalledReqs.length === 0) {
    process.stdout.write(JSON.stringify({}));
    appendLog({
      event: 'PostToolUse',
      session_id: input.session_id ?? null,
      turn_id: turnId,
      tool: input.tool_name ?? 'apply_patch',
      payload_sample: payloadSample,
      parse_error: parseError?.message ?? null,
      raw_diff_size: typeof rawDiff === 'string' ? rawDiff.length : JSON.stringify(rawDiff).length,
      diff_size: diff.length,
      recall_path_candidates: filePaths,
      recall_ids: [],
      critic_severity: 'skipped',
      skip_reason: 'no_strong_recall',
      matched: [],
      unmatched: [],
      matched_ids: [],
      unmatched_ids: [],
      covered_ids: [],
      weak_ids: [],
      conflict_ids: [],
      critic_classifications: [],
      would_block: false,
      blocked: false,
      gate_mode: 'observe',
      additional_context_emitted: false,
      context_chars: 0,
      recall_confidence: 'none',
      suppressed_reason: 'no_strong_recall',
      recall_modules: []
    });
    return;
  }

  let verdict = runCriticReview({ diff, recalledReqs });
  // LLM 复核层（默认关闭，HARNESS_LLM_CRITIC=1 开启）：捕获新增式违反禁止条款的行为。
  let llmMeta = { enabled: false, checked: [], violations: [], skippedReason: 'disabled' };
  try {
    const enhanced = await applyLlmCritic({
      verdict,
      recalledReqs,
      diff,
      selectCandidates: selectProhibitionCandidates
    });
    verdict = enhanced.verdict;
    llmMeta = enhanced.llm;
  } catch (error) {
    llmMeta = { enabled: true, checked: [], violations: [], skippedReason: `error:${error.message}` };
  }
  const feedback = formatCriticVerdict(verdict);
  const feedbackKey = [
    verdict.severity,
    verdict.covered.map(formatScopedId).join(','),
    verdict.weak.map(formatScopedId).join(','),
    verdict.conflicts.map(formatScopedId).join(',')
  ].join('|');
  const alreadyEmitted = turnId
    ? findEventsByTurn(turnId).some((event) => event.event === 'PostToolUse' && event.feedback_key === feedbackKey)
    : false;
  const shouldEmitContext = verdict.severity === 'critical' && !alreadyEmitted;

  const output = shouldEmitContext
    ? {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: feedback
        }
      }
    : {};

  const wouldBlock = false;

  process.stdout.write(JSON.stringify(output));
  appendLog({
    event: 'PostToolUse',
    session_id: input.session_id ?? null,
    turn_id: turnId,
    tool: input.tool_name ?? 'apply_patch',
    payload_sample: payloadSample,
    parse_error: parseError?.message ?? null,
    raw_diff_size: typeof rawDiff === 'string' ? rawDiff.length : JSON.stringify(rawDiff).length,
    diff_size: diff.length,
    recall_path_candidates: filePaths,
    recall_ids: recalledReqs.map(formatScopedId),
    critic_severity: verdict.severity,
    critic_signal: verdict.severity,
    skip_reason: null,
    matched_ids: verdict.covered.map(formatScopedId),
    unmatched_ids: verdict.weak.map(formatScopedId),
    weak_unmatched_ids: verdict.weak.map(formatScopedId),
    covered_ids: verdict.covered.map(formatScopedId),
    weak_ids: verdict.weak.map(formatScopedId),
    conflict_ids: verdict.conflicts.map(formatScopedId),
    critic_classifications: verdict.classifications ?? [],
    llm_critic: llmMeta,
    would_block: wouldBlock,
    blocked: false,
    gate_mode: 'observe',
    additional_context_emitted: shouldEmitContext,
    feedback_key: feedbackKey,
    context_chars: shouldEmitContext ? feedback.length : 0,
    recall_confidence: 'path_strong',
    suppressed_reason: shouldEmitContext ? null : alreadyEmitted ? 'duplicate_context' : verdict.severity === 'warning' ? 'weak_semantic_only' : 'semantic_covered',
    recall_modules: Array.from(new Set(recalledReqs.map((record) => record.scope)))
  });
};

main().catch((err) => {
  process.stderr.write(`[harness-hook critic] fatal: ${err.message}\n`);
  process.exit(0);
});
