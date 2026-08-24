#!/usr/bin/env node
// reqbank status —— 条款验证状态三态派生（P3）。
// 状态从 learning-log 重算、永不写回真源（agent-spec「liveness recomputed, never stored」）：
//   verified  最近一次 TC 验证命令通过，且之后无冲突记录
//   violated  最近一次验证失败，或验证后再次被判 conflict
//   stale     最近一次验证早于 --stale-days（默认 30 天）
//   unproven  从未验证过（诚实暴露「沉淀了但从未被执法」）
// REQ 的状态取其关联 TC 的最差值（violated > stale > unproven > verified）。
// 用法：node status.mjs [--stale-days 30] [--json] [--scope <模块>]

import { existsSync, readFileSync } from 'node:fs';
import { loadAllRequirements } from './lib/harness-store.mjs';
import { repoPath } from './lib/repo-paths.mjs';

const parseArgs = (argv) => {
  const options = { staleDays: 30, json: false, scope: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--stale-days') {
      index += 1;
      options.staleDays = Number(argv[index]) || 30;
    } else if (argv[index] === '--json') options.json = true;
    else if (argv[index] === '--scope') {
      index += 1;
      options.scope = argv[index];
    }
  }
  return options;
};

const readEvents = () => {
  const logPath = repoPath('.agentdoc', 'harness', 'learning-log.jsonl');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
};

const WORST = { violated: 3, stale: 2, unproven: 1, verified: 0 };

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const events = readEvents();
  const requirements = loadAllRequirements({ includeInactive: true })
    .filter((record) => !options.scope || record.scope === options.scope);
  const activeIds = new Set(loadAllRequirements().map((record) => `${record.scope}:${record.id}`));

  // 每个 TC 的最近 verify 事件
  const lastVerifyByTc = new Map();
  for (const event of events) {
    if (event.event === 'verify' && event.tc) {
      lastVerifyByTc.set(event.tc, event);
    }
  }
  // 每个 REQ 的最近一次 critic conflict 时间戳
  const lastConflictAtByReq = new Map();
  for (const event of events) {
    if (event.event === 'PostToolUse' && Array.isArray(event.conflict_ids)) {
      const ts = new Date(event.timestamp ?? 0).getTime();
      for (const id of event.conflict_ids) {
        lastConflictAtByReq.set(id, Math.max(lastConflictAtByReq.get(id) ?? 0, ts));
      }
    }
  }

  const staleCutoff = Date.now() - options.staleDays * 86400000;
  const rows = [];
  for (const record of requirements) {
    const scopedId = `${record.scope}:${record.id}`;
    const states = [];
    for (const tcId of record.relatedTests ?? []) {
      const fullTc = `${record.scope}:${tcId}`;
      const verify = lastVerifyByTc.get(fullTc);
      if (!verify) {
        states.push('unproven');
        continue;
      }
      const ts = new Date(verify.timestamp ?? 0).getTime();
      if (verify.ok === false) states.push('violated');
      else if (ts < staleCutoff) states.push('stale');
      else states.push('verified');
    }
    let state = states.length ? states.reduce((worst, s) => (WORST[s] > WORST[worst] ? s : worst)) : 'unproven';
    // 验证之后又出现冲突 → violated（即使命令曾通过）
    const conflictAt = lastConflictAtByReq.get(scopedId) ?? 0;
    const lastVerifyTs = (record.relatedTests ?? [])
      .map((tcId) => lastVerifyByTc.get(`${record.scope}:${tcId}`))
      .filter(Boolean)
      .reduce((max, e) => Math.max(max, new Date(e.timestamp ?? 0).getTime()), 0);
    if (conflictAt && conflictAt > lastVerifyTs) state = 'violated';
    rows.push({
      id: scopedId,
      title: record.title,
      lifecycle: activeIds.has(scopedId) ? 'active' : record.status ?? 'active',
      confidence: record.confidence ?? 'confirmed',
      state,
      tc_states: Object.fromEntries((record.relatedTests ?? []).map((tcId) => {
        const verify = lastVerifyByTc.get(`${record.scope}:${tcId}`);
        return [tcId, verify ? (verify.ok === false ? 'violated' : new Date(verify.timestamp ?? 0).getTime() < staleCutoff ? 'stale' : 'verified') : 'unproven'];
      }))
    });
  }

  const counts = rows.reduce((acc, row) => { acc[row.state] = (acc[row.state] ?? 0) + 1; return acc; }, {});
  const summary = { total: rows.length, by_state: counts, stale_days: options.staleDays, rows };
  if (options.json) {
    process.stdout.write(JSON.stringify(summary));
    return;
  }
  console.log(`[reqbank status] 条款验证状态（${rows.length} 条，stale 阈值 ${options.staleDays} 天）`);
  console.log(`  verified ${counts.verified ?? 0} / unproven ${counts.unproven ?? 0} / stale ${counts.stale ?? 0} / violated ${counts.violated ?? 0}`);
  const priority = { violated: 0, stale: 1, unproven: 2, verified: 3 };
  for (const row of [...rows].sort((a, b) => priority[a.state] - priority[b.state])) {
    if (row.state === 'verified' && row.confidence === 'confirmed') continue;
    const tcs = Object.entries(row.tc_states).map(([tc, s]) => `${tc}:${s}`).join(' ');
    console.log(`  ${row.state.padEnd(9)} ${row.id} [${row.confidence}] ${row.title}${tcs ? `（${tcs}）` : '（无 TC）'}`);
  }
};

main();
