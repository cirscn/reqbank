#!/usr/bin/env node
// PostToolUse hook on apply_patch: classify changed-file related REQ/TC as
// covered / weak / conflict and inject context only for deterministic conflicts.

import { extractKeywords, loadAssertionBearers, matchPathPattern, recallByPaths } from './lib/harness-store.mjs';
import { mergeAssertionPool, runAssertionReview, ASSERTION_FEEDBACK } from './lib/assertions.mjs';
import { formatCriticVerdict, runCriticReview, selectProhibitionCandidates } from './lib/critic-prompt.mjs';
import { applyLlmCritic } from './lib/llm-critic.mjs';
import { appendLog, appendPayloadSample, findEventsByTurn, parseHookPayload, readHookStdin } from './lib/learning-log.mjs';
import { extractChangedFilePaths, extractChangedLinesFromApplyPatch, normalizeChangedFilePath, normalizeClaudeCodeEdit } from './lib/patch-diff.mjs';

const formatScopedId = (record) => `${record.scope}:${record.id}`;

// P2 断言层命中 → 并入 verdict：升级 conflict、写入归因分类。
// 断言冲突是确定性的（闭集规则、零 LLM），优先级高于 n-gram 分类结果。
const mergeAssertionHits = (verdict, hits) => {
  const next = {
    ...verdict,
    covered: [...verdict.covered],
    weak: [...verdict.weak],
    conflicts: [...verdict.conflicts],
    classifications: [...(verdict.classifications ?? [])]
  };
  for (const hit of hits) {
    const record = hit.record;
    next.covered = next.covered.filter((item) => item !== record);
    next.weak = next.weak.filter((item) => item !== record);
    if (!next.conflicts.includes(record)) {
      next.conflicts.push(record);
    }
    next.classifications.push({
      id: `${record.scope}:${record.id}`,
      kind: 'conflict',
      assertion: { kind: hit.kind, pattern: hit.pattern, line: hit.matchedLine, advice: ASSERTION_FEEDBACK[hit.kind] }
    });
  }
  if (next.conflicts.length) {
    next.severity = 'critical';
    next.notes = `Assertion conflict: ${hits.map((hit) => `${hit.record.scope}:${hit.record.id} ${hit.kind}:${hit.pattern}`).join('; ')}`;
  }
  return next;
};

const main = async () => {
  const raw = await readHookStdin();
  const { input, parseError } = parseHookPayload(raw);
  const payloadSample = appendPayloadSample({ event: 'PostToolUse', raw, input, parseError });
  if (parseError) {
    process.stderr.write(`[harness-hook critic] stdin parse failed: ${parseError.message}\n`);
  }

  const turnId = input.turn_id ?? null;
  const toolInput = input.tool_input ?? {};
  // 双形状输入：Codex apply_patch 走 tool_input.command；Claude Code Edit/Write/MultiEdit
  // 走 file_path + old/new（或 structuredPatch），由 normalizeClaudeCodeEdit 归一。
  const claudeEdit = normalizeClaudeCodeEdit(input);
  const rawDiff = toolInput.command ?? claudeEdit?.text ?? '';
  const diff = extractChangedLinesFromApplyPatch(rawDiff);

  // PostToolUse 自主召回：不依赖 UserPromptSubmit 的关键词召回结果（容易伪召回 / classifyPromptKind 失灵），
  // 而是从本次 patch 实际改动的文件路径出发，按模块 strong 路径召回。
  // P1：req-only——TC 的 V 命令富含守卫词，混入召回会把真正被违反的 REQ 挤出 topK
  //（eval/FINDINGS 实证：删 REQ-006 守卫的 diff 召回了 REQ-005+TC）；每模块配额 2——双模块任务不再饿死。
  const filePaths = claudeEdit
    ? claudeEdit.filePaths.map((filePath) => normalizeChangedFilePath(filePath, { cwd: input.cwd ?? '' }))
    : extractChangedFilePaths(rawDiff, { cwd: input.cwd ?? '' });
  const recalledReqs = recallByPaths(filePaths, {
    keywords: extractKeywords(diff),
    recordKind: 'req-only',
    moduleQuota: 2
  });

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
      assertion_hits: [],
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

  // 断言层在 n-gram 分类器之前：闭集规则匹配，命中即确定性 conflict（含归因）
  // P5：断言池 = 召回集 ∪ 全库断言承载条款——跨模块违规不再依赖路径召回
  const assertionHits = await runAssertionReview({
    diff,
    filePaths,
    recalledReqs: mergeAssertionPool(recalledReqs, loadAssertionBearers()),
    matchPathPattern
  });

  let verdict = runCriticReview({ diff, recalledReqs });
  if (assertionHits.length) {
    verdict = mergeAssertionHits(verdict, assertionHits);
  }
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
  // P3 执法分级与内联抑制（抑制必须可见可数——BULDEE「documented, counted suppression」）：
  //  - diff 中出现 `reqbank-ignore: <scope:id>` → 该条款冲突降级 warning（记 suppressed_inline）
  //  - 条款索引第 5 列带 :warn → conflict 降级 warning（记 warn_downgrades）
  const suppressedInline = [];
  const warnDowngrades = [];
  if (verdict.conflicts?.length) {
    const diffText = String(diff);
    const downgraded = [];
    const keptConflicts = [];
    for (const record of verdict.conflicts) {
      const scopedId = formatScopedId(record);
      if (diffText.includes(`reqbank-ignore: ${scopedId}`)) {
        suppressedInline.push(scopedId);
        downgraded.push(record);
      } else if (record.enforcement === 'warn') {
        warnDowngrades.push(scopedId);
        downgraded.push(record);
      } else {
        keptConflicts.push(record);
      }
    }
    if (downgraded.length) {
      const weak = [...(verdict.weak ?? []), ...downgraded];
      verdict = {
        ...verdict,
        conflicts: keptConflicts,
        weak,
        severity: keptConflicts.length ? 'critical' : weak.length ? 'warning' : 'ok',
        notes: `${verdict.notes ?? ''}${verdict.notes ? '；' : ''}P3 降级：内联抑制 ${suppressedInline.length}、warn 档 ${warnDowngrades.length}`.trim()
      };
    }
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
    assertion_hits: assertionHits.map((hit) => ({
      id: `${hit.record.scope}:${hit.record.id}`,
      kind: hit.kind,
      pattern: hit.pattern,
      line: hit.matchedLine,
      ast: hit.confirmedByAst ?? null
    })),
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
    suppressed_inline: suppressedInline,
    warn_downgrades: warnDowngrades,
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
