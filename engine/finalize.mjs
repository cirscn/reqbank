#!/usr/bin/env node
// Stop hook: aggregate this turn's events and hard-block only deterministic
// harness failures. Weak semantic critic signals stay in the audit log.

import { getDirtyBusinessFileChangesSinceBaseline } from './lib/dirty-files.mjs';
import { loadAllRequirements } from './lib/harness-store.mjs';
import { formatFinalizeFeedback } from './lib/critic-prompt.mjs';
import { appendLog, appendPayloadSample, findEventsByTurn, parseHookPayload, readHookStdin } from './lib/learning-log.mjs';

const DIRTY_FILE_LOG_LIMIT = 20;

const shouldAuditDirtyFiles = (turnEvents) => {
  const userPromptEvents = turnEvents.filter((event) => event.event === 'UserPromptSubmit');
  if (!userPromptEvents.length) {
    return false;
  }

  const promptKinds = userPromptEvents
    .map((event) => event.prompt_kind)
    .filter(Boolean);
  if (!promptKinds.length) {
    return true;
  }
  return promptKinds.some((kind) => ['implementation', 'verification', 'unknown'].includes(kind));
};

const getDirtyBusinessFileBaseline = (turnEvents) => {
  const userPromptEvents = turnEvents.filter((event) => event.event === 'UserPromptSubmit');
  return userPromptEvents.at(-1)?.dirty_business_file_baseline;
};

const emitAndExit = ({ output, logRecord }) => {
  process.stdout.write(JSON.stringify(output));
  appendLog(logRecord);
};

const main = async () => {
  const raw = await readHookStdin();
  const { input, parseError } = parseHookPayload(raw);
  const payloadSample = appendPayloadSample({ event: 'Stop', raw, input, parseError });
  if (parseError) {
    process.stderr.write(`[harness-hook finalize] stdin parse failed: ${parseError.message}\n`);
  }

  const turnId = input.turn_id ?? null;
  const turnEvents = turnId ? findEventsByTurn(turnId) : [];

  const issues = [];

  const criticEvents = turnEvents.filter((event) => event.event === 'PostToolUse');
  const lastCritic = criticEvents.at(-1);
  if (lastCritic?.critic_severity === 'critical') {
    issues.push(`PostToolUse critic 记录 semantic conflict：${lastCritic.conflict_ids?.join(', ') || 'unknown'}。`);
  }

  const allRecallIds = new Set();
  for (const event of turnEvents.filter((event) => event.event === 'UserPromptSubmit')) {
    for (const id of event.recall_hits ?? []) {
      allRecallIds.add(id);
    }
  }
  const dirtyBusinessFileBaseline = getDirtyBusinessFileBaseline(turnEvents);
  const auditDirtyFiles = shouldAuditDirtyFiles(turnEvents);
  const dirtyBusinessFileChanges = auditDirtyFiles
    ? getDirtyBusinessFileChangesSinceBaseline(dirtyBusinessFileBaseline)
    : { newFiles: [], changedExistingFiles: [] };
  const newBusinessFiles = dirtyBusinessFileChanges.newFiles;
  const changedExistingBusinessFiles = dirtyBusinessFileChanges.changedExistingFiles;
  if (parseError) {
    issues.push(`Stop hook payload 不可解析：${parseError.message}`);
  }

  const allReqsCount = loadAllRequirements().length;

  const output = {};
  const blocked = issues.length > 0;
  const systemMessage = formatFinalizeFeedback(issues);
  if (issues.length) {
    output.decision = 'block';
    output.reason = systemMessage;
  }

  emitAndExit({
    output,
    logRecord: {
    event: 'Stop',
    session_id: input.session_id ?? null,
    turn_id: turnId,
    payload_sample: payloadSample,
    parse_error: parseError?.message ?? null,
    issues,
    decision: blocked ? 'block' : 'allow',
    would_block: issues.length > 0,
    blocked,
    gate_mode: blocked ? 'hard-block' : 'allow',
    recall_set_size: allRecallIds.size,
    critic_event_count: criticEvents.length,
    dirty_business_file_baseline_count: Array.isArray(dirtyBusinessFileBaseline)
      ? dirtyBusinessFileBaseline.length
      : null,
    changed_business_file_count: newBusinessFiles.length + changedExistingBusinessFiles.length,
    new_business_file_count: newBusinessFiles.length,
    changed_existing_business_file_count: changedExistingBusinessFiles.length,
    new_business_files: newBusinessFiles.slice(0, DIRTY_FILE_LOG_LIMIT),
    changed_existing_business_files: changedExistingBusinessFiles.slice(0, DIRTY_FILE_LOG_LIMIT),
    dirty_business_file_list_limit: DIRTY_FILE_LOG_LIMIT,
    dirty_business_file_gate_mode: auditDirtyFiles ? 'audit' : 'skipped',
    total_req_count: allReqsCount,
    context_chars: systemMessage.length,
    recall_modules: Array.from(new Set(
      turnEvents
        .flatMap((event) => event.recall_modules ?? [])
        .filter(Boolean)
    ))
    }
  });
};

main().catch((err) => {
  process.stderr.write(`[harness-hook finalize] fatal: ${err.message}\n`);
  process.exit(0);
});
