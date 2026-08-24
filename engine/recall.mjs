#!/usr/bin/env node
// UserPromptSubmit hook: extract task keywords, recall relevant REQ/TC, inject
// them into agent context so the agent doesn't have to manually grep harness.

import { extractKeywords, extractPathCandidates, recallByKeywords, recallByPaths, recallPendingModulesByPaths } from './lib/harness-store.mjs';
import { formatRecallContext } from './lib/critic-prompt.mjs';
import { getDirtyBusinessFileRecords } from './lib/dirty-files.mjs';
import { appendLog, appendPayloadSample, parseHookPayload, readHookStdin } from './lib/learning-log.mjs';
import { classifyPromptKind, shouldRunBusinessRecall } from './lib/prompt-classifier.mjs';

const formatPendingModuleContext = (pendingModules) => {
  if (!pendingModules.length) {
    return '';
  }
  const lines = ['', '待初始化模块命中：'];
  for (const module of pendingModules) {
    lines.push(`- ${module.name} | 标签：${module.tags.join(', ') || 'none'} | 路径：${module.paths.join(', ')}`);
  }
  lines.push('提示：上述模块暂无已沉淀 REQ/TC；若本任务形成持久业务契约或修复可复用 bug，提交前需要初始化模块 harness。');
  return lines.join('\n');
};

const main = async () => {
  const raw = await readHookStdin();
  const { input, parseError } = parseHookPayload(raw);
  const payloadSample = appendPayloadSample({ event: 'UserPromptSubmit', raw, input, parseError });
  if (parseError) {
    process.stderr.write(`[harness-hook recall] stdin parse failed: ${parseError.message}\n`);
  }

  const prompt = input.prompt ?? '';
  const promptKind = classifyPromptKind(prompt);
  const pathCandidates = extractPathCandidates(prompt);
  const shouldRecall = shouldRunBusinessRecall(promptKind);
  const keywords = shouldRecall ? extractKeywords(prompt) : [];
  const pathRecalled = shouldRecall && pathCandidates.length ? recallByPaths(pathCandidates, { topK: 3, keywords }) : [];
  const keywordRecalled = shouldRecall && !pathRecalled.length ? recallByKeywords(keywords, { topK: 3 }) : [];
  const recalled = pathRecalled.length ? pathRecalled : keywordRecalled;
  const recallStrategy = !shouldRecall ? 'skipped' : pathRecalled.length ? 'paths' : keywordRecalled.length ? 'keywords' : 'none';
  const pendingModuleHits = shouldRecall && !recalled.length ? recallPendingModulesByPaths(pathCandidates, { topK: 3 }) : [];
  const additionalContext = shouldRecall
    ? [
        formatRecallContext(recalled),
        formatPendingModuleContext(pendingModuleHits)
      ].filter(Boolean).join('\n')
    : '';

  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
    }
  };
  if (additionalContext) {
    output.hookSpecificOutput.additionalContext = additionalContext;
  }

  process.stdout.write(JSON.stringify(output));
  const dirtyBusinessFileBaseline = getDirtyBusinessFileRecords();
  appendLog({
    event: 'UserPromptSubmit',
    session_id: input.session_id ?? null,
    turn_id: input.turn_id ?? null,
    payload_sample: payloadSample,
    parse_error: parseError?.message ?? null,
    prompt_summary: prompt.slice(0, 200),
    prompt_kind: promptKind,
    recall_skipped: !shouldRecall,
    suppressed_reason: !shouldRecall ? promptKind : recalled.length || pendingModuleHits.length ? null : 'no_hits',
    keyword_count: keywords.length,
    path_candidates: pathCandidates,
    recall_strategy: recallStrategy,
    recall_hits: recalled.map((record) => `${record.scope}:${record.id}`),
    recall_ids: recalled.map((record) => `${record.scope}:${record.id}`),
    recall_modules: Array.from(new Set(recalled.map((record) => record.scope))),
    recall_confidence: recalled.length ? recallStrategy : 'none',
    context_chars: additionalContext.length,
    pending_module_hits: pendingModuleHits.map((module) => module.name),
    dirty_business_file_baseline: dirtyBusinessFileBaseline,
    dirty_business_file_baseline_count: dirtyBusinessFileBaseline.length
  });
};

main().catch((err) => {
  process.stderr.write(`[harness-hook recall] fatal: ${err.message}\n`);
  process.exit(0);
});
