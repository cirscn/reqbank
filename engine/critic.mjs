#!/usr/bin/env node
// PostToolUse hook on apply_patch: classify changed-file related REQ/TC as
// covered / weak / conflict and inject context only for deterministic conflicts.

import { extractKeywords, loadAssertionBearers, matchPathPattern, recallByPaths } from './lib/harness-store.mjs';
import { mergeAssertionPool, runAssertionReview, ASSERTION_FEEDBACK } from './lib/assertions.mjs';
import { formatCriticVerdict, runCriticReview, selectProhibitionCandidates } from './lib/critic-prompt.mjs';
import { formatScopedId, partitionRecords, uniqueRecords } from './lib/enforcement.mjs';
import { applyLlmCritic } from './lib/llm-critic.mjs';
import { appendLog, appendPayloadSample, findEventsByTurn, parseHookPayload, readHookStdin } from './lib/learning-log.mjs';
import { isBusinessFile } from './lib/dirty-files.mjs';
import { extractChangedFilePaths, extractChangedLinesFromApplyPatch, normalizeChangedFilePath, normalizeClaudeCodeEdit } from './lib/patch-diff.mjs';

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

  // 断言层在 n-gram 之前：闭集规则匹配。路径召回为空仍扫断言池——未登记路径删守卫 token 也硬拦。
  const assertionHits = await runAssertionReview({
    diff,
    filePaths,
    recalledReqs: mergeAssertionPool(recalledReqs, loadAssertionBearers()),
    matchPathPattern
  });

  if (recalledReqs.length === 0 && assertionHits.length === 0) {
    // P5 沉淀提醒：零覆盖业务编辑触发当次会话 AI 自起草契约候选——提取靠有完整上下文的当前
    // agent 本身，不依赖外部 LLM key。按文件去重（0.18.0 起，替代旧的每回合一次）：
    // 多文件回合每个未提醒过的新文件都独立提示，重复编辑同一文件不重复打扰。
    const nudgedFiles = new Set(turnId
      ? findEventsByTurn(turnId)
          .filter((event) => event.event === 'PostToolUse' && event.distill_nudge_emitted)
          .flatMap((event) => event.recall_path_candidates ?? [])
      : []);
    // 只对业务文件提醒：引擎/真源等元路径的编辑不算沉淀素材
    const nudgeTargets = filePaths.filter((filePath) => {
      if (nudgedFiles.has(filePath)) {
        return false;
      }
      try {
        return isBusinessFile(filePath);
      } catch {
        return true;
      }
    });
    let distillNudgeEmitted = false;
    let output = {};
    if (nudgeTargets.length) {
      const stamp = new Date().toISOString().slice(0, 10);
      const nudgeContext = [
        `[reqbank 自动沉淀] 本回合改动未注册模块的业务文件（每文件提醒一次）：${nudgeTargets.slice(0, 3).join('、')}`,
        `若本次修改形成持久业务契约或修复了可复用 bug，请在收尾前向 .agentdoc/harness/inbox/stop-${stamp}.md 追加人审草稿卡（同名卡片已存在则跳过）：`,
        'N. [ai-draft] <不超过40字、含否定语义的标题>',
        '   标签：<逗号分隔标签>',
        '   建议：候选正文：<「不得」句式契约——真源字段名、守卫 token、边界与违反后果；无值得沉淀的契约则不追加>',
        '若该区域尚无模块覆盖，收尾时 Stop 钩子会按真实改动自动起草模块候选到 inbox/module-drafts/；',
        '也可在本回合内按 agent-guide 五步协议直接初始化模块 harness。只写 inbox 草稿，不得直接修改 modules/。'
      ].join('\n');
      output = {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: nudgeContext
        }
      };
      distillNudgeEmitted = true;
    }
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
      additional_context_emitted: distillNudgeEmitted,
      context_chars: distillNudgeEmitted ? JSON.stringify(output).length : 0,
      recall_confidence: 'none',
      suppressed_reason: 'no_strong_recall',
      recall_modules: [],
      distill_nudge_emitted: distillNudgeEmitted
    });
    return;
  }

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
  // P3 执法分级：ignore / :warn 与 PreToolUse / Stop / gate 同口径（降级不硬拦，且 counted）。
  const leftover = partitionRecords(verdict.conflicts ?? [], diff);
  const suppressedInline = leftover.ignored.map(formatScopedId);
  const warnDowngrades = leftover.warned.map(formatScopedId);
  if (leftover.ignored.length || leftover.warned.length) {
    const weak = uniqueRecords([...(verdict.weak ?? []), ...leftover.ignored, ...leftover.warned]);
    verdict = {
      ...verdict,
      conflicts: leftover.blocking,
      weak,
      severity: leftover.blocking.length ? 'critical' : weak.length ? 'warning' : 'ok',
      notes: `${verdict.notes ?? ''}${verdict.notes ? '；' : ''}P3 降级：内联抑制 ${suppressedInline.length}、warn 档 ${warnDowngrades.length}`.trim()
    };
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
    recall_confidence: recalledReqs.length ? 'path_strong' : 'assertion_pool',
    suppressed_reason: shouldEmitContext ? null : alreadyEmitted ? 'duplicate_context' : verdict.severity === 'warning' ? 'weak_semantic_only' : 'semantic_covered',
    recall_modules: Array.from(new Set(recalledReqs.map((record) => record.scope)))
  });
};

main().catch((err) => {
  process.stderr.write(`[harness-hook critic] fatal: ${err.message}\n`);
  process.exit(0);
});
