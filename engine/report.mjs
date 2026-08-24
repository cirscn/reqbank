#!/usr/bin/env node
// harness report —— 守门体系度量：learning-log.jsonl 的召回率 / critic 分布 / 阻断趋势。
// 用法：node report.mjs [--json] [--days 7]

import { existsSync, readFileSync } from 'node:fs';
import { getProjectRoot, repoPath } from './lib/repo-paths.mjs';

const parseArgs = (argv) => {
  const options = { json: false, days: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--json') options.json = true;
    else if (argv[index] === '--days') {
      index += 1;
      options.days = Number(argv[index]) || 0;
    }
  }
  return options;
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
    llm_critic_violations: llmViolations
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(summary));
  } else {
    console.log('[harness report] 守门体系度量');
    console.log(`  提示回合: ${summary.turns_prompted}（业务 ${summary.turns_business}，其中召回命中 ${summary.turns_recalled}，命中率 ${summary.recall_hit_rate ?? '-'}）`);
    console.log(`  critic 审计 patch: ${summary.critic_patches}（critical ${criticBySeverity.critical} / warning ${criticBySeverity.warning} / ok ${criticBySeverity.ok}）`);
    console.log(`  Stop: ${summary.stop_turns} 回合，阻断 ${summary.stop_blocked}`);
    console.log(`  LLM critic 复核条款 ${llmChecked} 条，判违规 ${llmViolations}`);
    if (!events.length) {
      console.log('  （learning-log 为空——钩子链路可能未接入或尚无会话）');
    }
  }
};

main();
