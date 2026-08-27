#!/usr/bin/env node
// Stop hook: aggregate this turn's events and hard-block only deterministic
// harness failures. Weak semantic critic signals stay in the audit log.

import { spawnSync } from 'node:child_process';
import { getBusinessFileUnifiedDiff, getDirtyBusinessFileChangesSinceBaseline, getDirtyBusinessFileRecords } from './lib/dirty-files.mjs';
import { extractKeywords, loadAssertionBearers, matchPathPattern, loadAllRequirements, loadAllTests, recallByPaths } from './lib/harness-store.mjs';
import { formatFinalizeFeedback } from './lib/critic-prompt.mjs';
import { mergeAssertionPool, runAssertionReview } from './lib/assertions.mjs';
import { partitionAssertionHits } from './lib/enforcement.mjs';
import { extractCommands, findUnsafe, tcShell } from './lib/tc-exec.mjs';
import { getProjectRoot } from './lib/repo-paths.mjs';
import { runStopDistill } from './lib/distill.mjs';
import { appendLog, appendPayloadSample, findEventsByTurn, parseHookPayload, readHookStdin } from './lib/learning-log.mjs';

const DIRTY_FILE_LOG_LIMIT = 20;

const shouldAuditDirtyFiles = (turnEvents) => {
  const userPromptEvents = turnEvents.filter((event) => event.event === 'UserPromptSubmit');
  if (!userPromptEvents.length) {
    return false; // 未知 turn_id：不扫全库脏文件
  }

  const promptKinds = userPromptEvents
    .map((event) => event.prompt_kind)
    .filter(Boolean);
  if (!promptKinds.length) {
    return true;
  }
  return promptKinds.some((kind) => ['implementation', 'verification', 'unknown', 'analysis'].includes(kind));
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

  let issues = [];

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

  // P1 终态裁决（修 B7「先脏后净」绕过）：不信过程信终态——对本回合真正变化的业务文件
  // 取盘上 git diff（unstaged+staged），复用确定性分类器对照条款重算。
  // 此前只回放最后一条 critic 事件：先违规编辑、再做一次干净编辑即可让 Stop 放行，违规仍留在盘上。
  const terminalConflictIds = [];
  const terminalSuppressed = [];
  const terminalWarns = [];
  // 对照 HEAD 审当前全部脏业务文件：analysis 回合若在召回前已经把违规写进盘，baseline 会把脏当存量。
  // 无 UserPromptSubmit（未知 turn_id）不扫全库——G04。
  const terminalFiles = auditDirtyFiles
    ? [...new Set(getDirtyBusinessFileRecords().map((record) => record.file))]
    : [];
  const assertionBearers = auditDirtyFiles && terminalFiles.length ? loadAssertionBearers() : [];
  // 沉淀层输入：终态裁决循环里顺带记录「零召回且无断言命中」的业务文件与 diff 快照，零额外 IO。
  const distillUncoveredFiles = [];
  const distillDiffTexts = new Map();
  if (auditDirtyFiles && terminalFiles.length) {
    try {
      for (const file of terminalFiles.slice(0, DIRTY_FILE_LOG_LIMIT)) {
        const diff = getBusinessFileUnifiedDiff(file);
        if (!diff.trim()) {
          continue;
        }
        const recalled = recallByPaths([file], {
          keywords: extractKeywords(diff),
          recordKind: 'req-only',
          moduleQuota: 2
        });
        const assertionHits = await runAssertionReview({
          diff,
          filePaths: [file],
          recalledReqs: mergeAssertionPool(recalled, assertionBearers),
          matchPathPattern
        });
        if (!recalled.length && !assertionHits.length) {
          distillUncoveredFiles.push(file);
          distillDiffTexts.set(file, diff.slice(0, 4000));
        }
        const { blocking, warned, ignored } = partitionAssertionHits(assertionHits, diff);
        for (const hit of blocking) {
          terminalConflictIds.push(hit.scopedId);
        }
        for (const hit of ignored) {
          terminalSuppressed.push(hit.scopedId);
        }
        for (const hit of warned) {
          terminalWarns.push(hit.scopedId);
        }
      }
    } catch (error) {
      // 终态裁决是新增执法层：任何异常 fail-open 回落既有日志回放路径，不引入新拦截
      process.stderr.write(`[harness-hook finalize] terminal review skipped: ${error.message}\n`);
    }
  }
  for (const id of [...new Set(terminalConflictIds)]) {
    issues.push(`终态裁决：${id} 对照盘上 diff 判定确定性冲突——守卫被删且未恢复。继续真实修复，或撤销违规改动后再结束。`);
  }
  if (parseError) {
    issues.push(`Stop hook payload 不可解析：${parseError.message}`);
  }

  // P4 Stop 自动验证命中 TC（默认关闭，HARNESS_STOP_VERIFY=1 开启——命令执行风险边界保守设计）：
  // 冲突条款挂的 TC 真跑一遍：TC 失败 → 追加阻断理由（引用 TC）；可执行 TC 全过 → 该冲突降级为提示
  //（守卫消失但测试绿——交人工确认，不硬拦）。危险命令确定性拒绝并计为失败。
  const stopTcResults = [];
  const stopTcDowngrades = [];
  if (process.env.HARNESS_STOP_VERIFY === '1' && issues.length) {
    try {
      const conflictIds = [...new Set([
        ...terminalConflictIds,
        ...(lastCritic?.critic_severity === 'critical' ? (lastCritic.conflict_ids ?? []) : [])
      ])];
      const allReqs = loadAllRequirements({ includeInactive: true });
      const tcById = new Map(loadAllTests({ includeInactive: true }).map((t) => [`${t.scope}:${t.id}`, t]));
      for (const id of conflictIds) {
        const req = allReqs.find((record) => `${record.scope}:${record.id}` === id);
        if (!req?.relatedTests?.length) continue;
        let ran = 0;
        let failed = 0;
        for (const tcId of req.relatedTests) {
          const tc = tcById.get(`${req.scope}:${tcId}`);
          for (const command of extractCommands(tc?.verify?.[0] ?? '')) {
            if (!process.env.HARNESS_VERIFY_ALLOW_UNSAFE) {
              const unsafeLabel = findUnsafe(command);
              if (unsafeLabel) {
                ran += 1;
                failed += 1;
                stopTcResults.push({ id, tc: tcId, command, exit: null, rejected: `unsafe:${unsafeLabel}` });
                continue;
              }
            }
            ran += 1;
            const result = spawnSync(command, { cwd: getProjectRoot(), encoding: 'utf8', shell: tcShell(), timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
            const pass = result.status === 0;
            if (!pass) failed += 1;
            stopTcResults.push({ id, tc: tcId, command, exit: result.status, pass });
          }
        }
        if (ran > 0 && failed === 0) {
          stopTcDowngrades.push(id);
          issues = issues.filter((issue) => !issue.includes(id));
        } else if (failed > 0) {
          issues.push(`终态 TC 验证失败：${id} 挂载的 TC 未通过（见 learning-log stop_tc_results）——修复后再结束。`);
        }
      }
    } catch (error) {
      process.stderr.write(`[harness-hook finalize] stop tc-verify skipped: ${error.message}\n`);
    }
  }

  const allReqsCount = loadAllRequirements().length;

  // Stop 沉淀：只写 inbox/ 草稿卡，不参与 block 判定；任何异常 fail-open 不影响放行/拦截语义。
  let distill = null;
  if (auditDirtyFiles) {
    try {
      distill = await runStopDistill({ uncoveredFiles: distillUncoveredFiles, diffTexts: distillDiffTexts });
    } catch (error) {
      process.stderr.write(`[harness-hook finalize] distill skipped: ${error.message}\n`);
    }
  }

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
    terminal_conflict_ids: [...new Set(terminalConflictIds)],
    suppressed_inline: [...new Set(terminalSuppressed)],
    warn_downgrades: [...new Set(terminalWarns)],
    stop_tc_results: stopTcResults,
    stop_tc_downgrades: stopTcDowngrades,
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
    )),
    distill_deterministic_cards: distill?.deterministic_cards ?? [],
    distill_llm_drafts: distill?.llm_drafts ?? [],
    distill_module_drafts: distill?.module_drafts ?? [],
    distill_llm_enabled: distill?.llm_enabled ?? false,
    distill_skipped_reason: distill ? (distill.skipped_reason ?? null) : 'audit_skipped'
    }
  });
};

main().catch((err) => {
  process.stderr.write(`[harness-hook finalize] fatal: ${err.message}\n`);
  process.exit(0);
});
