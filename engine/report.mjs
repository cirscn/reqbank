#!/usr/bin/env node
// harness report —— 守门体系度量：learning-log.jsonl 的召回率 / critic 分布 / 阻断趋势。
// P3 report 2.0：+ REQ 终态矩阵（conflict/covered/weak/never-seen）、block 整改率、召回质量
//（策略分布/注入预算分位/召回闭环率/执法消费率）、dead-rule、--snapshot 快照棘轮（度量本身成为门禁）。
// 用法：node report.mjs [--json] [--days 7] [--snapshot [--check]]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { getProjectRoot, repoPath } from './lib/repo-paths.mjs';
import { loadAllRequirements } from './lib/harness-store.mjs';

const parseArgs = (argv) => {
  const options = { json: false, days: 0, snapshot: false, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--json') options.json = true;
    else if (argv[index] === '--days') {
      index += 1;
      options.days = Number(argv[index]) || 0;
    } else if (argv[index] === '--snapshot') options.snapshot = true;
    else if (argv[index] === '--check') options.check = true;
  }
  return options;
};

const percentile = (sortedValues, p) => {
  if (!sortedValues.length) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * p));
  return sortedValues[index];
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const logPath = repoPath('.agentdoc', 'harness', 'learning-log.jsonl');
  let events = [];
  if (existsSync(logPath)) {
    const cutoff = options.days ? Date.now() - options.days * 86400000 : 0;
    for (const line of readFileSync(logPath, 'utf8').split('\n').filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        if (!cutoff || new Date(event.timestamp ?? event.time ?? 0).getTime() >= cutoff) {
          events.push(event);
        }
      } catch {}
    }
  }

  const promptEvents = events.filter((event) => event.event === 'UserPromptSubmit');
  const businessTurns = promptEvents.filter((event) => !event.recall_skipped);
  const hitTurns = businessTurns.filter((event) => (event.recall_ids?.length ?? 0) > 0);
  const criticEvents = events.filter((event) => event.event === 'PostToolUse' && event.critic_severity);
  const criticBySeverity = { critical: 0, warning: 0, ok: 0, skipped: 0 };
  for (const event of criticEvents) {
    criticBySeverity[event.critic_severity] = (criticBySeverity[event.critic_severity] ?? 0) + 1;
  }
  const stopEvents = events.filter((event) => event.event === 'Stop');
  const blockedStops = stopEvents.filter((event) => event.decision === 'block');
  const llmChecked = events.reduce((sum, event) => sum + (event.llm_critic?.checked?.length ?? 0), 0);
  const llmViolations = events.reduce((sum, event) => sum + (event.llm_critic?.violations?.length ?? 0), 0);

  // ── P3 REQ 终态矩阵：每条 REQ 取最近一次 critic 分类 ──
  let requirements = [];
  try {
    requirements = loadAllRequirements({ includeInactive: true });
  } catch {}
  const lastKindByReq = new Map();
  const conflictEvents = [];
  const coveredEvents = [];
  for (const event of criticEvents) {
    const ts = new Date(event.timestamp ?? 0).getTime();
    for (const entry of event.critic_classifications ?? []) {
      lastKindByReq.set(entry.id, { kind: entry.kind === 'conflict' ? 'conflict' : entry.kind, ts });
    }
    for (const id of event.conflict_ids ?? []) { lastKindByReq.set(id, { kind: 'conflict', ts }); conflictEvents.push({ id, ts }); }
    for (const id of event.covered_ids ?? []) coveredEvents.push({ id, ts });
  }
  const byReq = {};
  const recalledEver = new Set();
  for (const event of events) {
    for (const id of event.recall_ids ?? []) recalledEver.add(id);
  }
  for (const record of requirements) {
    const scopedId = `${record.scope}:${record.id}`;
    byReq[scopedId] = lastKindByReq.get(scopedId)?.kind
      ?? (recalledEver.has(scopedId) ? 'weak' : 'never-seen');
  }
  const matrixCounts = Object.values(byReq).reduce((acc, state) => { acc[state] = (acc[state] ?? 0) + 1; return acc; }, {});

  // ── P3 整改率：被 block 回合的冲突条款，其后是否转为 covered ──
  let remediationRate = null;
  {
    const blockedConflictIds = new Set();
    for (const stop of blockedStops) {
      if (!stop.turn_id) continue;
      for (const critic of criticEvents) {
        if (critic.turn_id === stop.turn_id) {
          for (const id of critic.conflict_ids ?? []) blockedConflictIds.add(id);
        }
      }
    }
    const remediable = [...blockedConflictIds];
    if (remediable.length) {
      const remediated = remediable.filter((id) =>
        coveredEvents.some((entry) => entry.id === id && !conflictEvents.some((c) => c.id === id && c.ts > entry.ts))
      ).length;
      remediationRate = Number((remediated / remediable.length).toFixed(2));
    }
  }

  // ── P3 召回质量 ──
  const strategyCounts = {};
  for (const event of businessTurns) {
    const strategy = event.recall_strategy ?? 'none';
    strategyCounts[strategy] = (strategyCounts[strategy] ?? 0) + 1;
  }
  const contextSizes = businessTurns.map((event) => event.context_chars ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  let closureRate = null;
  {
    const criticRecallByTurn = new Map();
    for (const event of criticEvents) {
      if (event.turn_id) criticRecallByTurn.set(event.turn_id, new Set(event.recall_ids ?? []));
    }
    const both = businessTurns.filter((event) => event.turn_id && criticRecallByTurn.has(event.turn_id));
    if (both.length) {
      const closed = both.filter((event) => (event.recall_ids ?? []).some((id) => criticRecallByTurn.get(event.turn_id).has(id))).length;
      closureRate = Number((closed / both.length).toFixed(2));
    }
  }
  let consumptionRate = null;
  {
    const recalledCritics = criticEvents.filter((event) => (event.recall_ids?.length ?? 0) > 0);
    if (recalledCritics.length) {
      const consumed = recalledCritics.filter((event) =>
        (event.covered_ids?.length ?? 0) + (event.weak_ids?.length ?? 0) + (event.conflict_ids?.length ?? 0) > 0).length;
      consumptionRate = Number((consumed / recalledCritics.length).toFixed(2));
    }
  }
  const deadRules = requirements
    .filter((record) => record.status === 'active' && !recalledEver.has(`${record.scope}:${record.id}`))
    .map((record) => `${record.scope}:${record.id}`);

  // ── P3 快照棘轮：契约覆盖任何变化都须显式更新快照 ──
  const snapshotLines = Object.keys(byReq).sort().map((id) => `${id}\t${byReq[id]}`);
  const snapshotPath = repoPath('.agentdoc', 'harness', 'report-snapshot.txt');
  if (options.snapshot && options.check) {
    const existing = existsSync(snapshotPath) ? readFileSync(snapshotPath, 'utf8').split('\n').filter(Boolean) : null;
    const current = snapshotLines;
    if (!existing || existing.join('\n') !== current.join('\n')) {
      const added = current.filter((l) => !existing?.includes(l));
      const removed = (existing ?? []).filter((l) => !current.includes(l));
      console.error(`[reqbank report] 快照不一致：+${added.length} / -${removed.length}`);
      for (const line of [...added, ...removed].slice(0, 10)) console.error(`    ${line}`);
      console.error('契约覆盖发生变化（新增未执法条款/条款转冲突等）——重跑 `report --snapshot` 更新并随本次提交。');
      process.exit(1);
    }
    console.log('[reqbank report] 快照一致 ✓');
    return;
  }

  const summary = {
    window_days: options.days || 'all',
    turns_prompted: promptEvents.length,
    turns_business: businessTurns.length,
    turns_recalled: hitTurns.length,
    recall_hit_rate: businessTurns.length ? Number((hitTurns.length / businessTurns.length).toFixed(2)) : null,
    critic_patches: criticEvents.length,
    critic_severity: criticBySeverity,
    stop_turns: stopEvents.length,
    stop_blocked: blockedStops.length,
    llm_critic_checked_records: llmChecked,
    llm_critic_violations: llmViolations,
    req_matrix: matrixCounts,
    req_total: requirements.length,
    remediation_rate: remediationRate,
    recall_strategy: strategyCounts,
    context_chars_p50: percentile(contextSizes, 0.5),
    context_chars_p95: percentile(contextSizes, 0.95),
    recall_closure_rate: closureRate,
    enforcement_consumption_rate: consumptionRate,
    dead_rules: deadRules
  };

  if (options.snapshot) {
    writeFileSync(snapshotPath, `${snapshotLines.join('\n')}\n`);
    console.log(`[reqbank report] 快照已写入 ${snapshotPath}（${snapshotLines.length} 条款）——提交进版本库，CI 用 --check 比对`);
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(summary));
  } else {
    console.log('[harness report] 守门体系度量');
    console.log(`  提示回合: ${summary.turns_prompted}（业务 ${summary.turns_business}，其中召回命中 ${summary.turns_recalled}，命中率 ${summary.recall_hit_rate ?? '-'}）`);
    console.log(`  critic 审计 patch: ${summary.critic_patches}（critical ${criticBySeverity.critical} / warning ${criticBySeverity.warning} / ok ${criticBySeverity.ok}）`);
    console.log(`  Stop: ${summary.stop_turns} 回合，阻断 ${summary.stop_blocked}${remediationRate !== null ? `，整改率 ${remediationRate}` : ''}`);
    console.log(`  LLM critic 复核条款 ${llmChecked} 条，判违规 ${llmViolations}`);
    console.log(`  REQ 终态: conflict ${matrixCounts.conflict ?? 0} / covered ${matrixCounts.covered ?? 0} / weak ${matrixCounts.weak ?? 0} / never-seen ${matrixCounts['never-seen'] ?? 0}（共 ${summary.req_total} 条）`);
    console.log(`  召回质量: 策略分布 ${JSON.stringify(strategyCounts)}；注入 p50/p95 ${summary.context_chars_p50 ?? '-'} / ${summary.context_chars_p95 ?? '-'} chars；闭环率 ${closureRate ?? '-'}；执法消费率 ${consumptionRate ?? '-'}`);
    if (deadRules.length) console.log(`  dead-rule（窗口内零召回）: ${deadRules.slice(0, 6).join(', ')}${deadRules.length > 6 ? ` 等 ${deadRules.length} 条` : ''}`);
    if (!events.length) {
      console.log('  （learning-log 为空——钩子链路可能未接入或尚无会话）');
    }
  }
};

main();
