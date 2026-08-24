#!/usr/bin/env node
// reqbank mine —— 冷启动考古挖掘（P4「考古入金」首发）。
// 把存量项目里的隐式契约挖成候选条款，一律写 inbox/ 草稿区待人审——mine 永不直接写 modules/。
//
// 确定性证据源（默认，零 LLM）：
//   git-fix      git log 里 fix/bug/修复/回滚 主题 → 「这类问题不得再犯」候选
//   instruction  AGENTS.md/CLAUDE.md/README 里的祈使句（不得/禁止/必须）→ 直接候选
//   todo         TODO/FIXME 注释 → 隐性债务候选
//   hotspot      高频改动文件 → 建议初始化模块 harness
// LLM 增强层（可选）：HARNESS_LLM_DRAFT=1 时对候选正文做澄清润色（fail-open，无 key 静默跳过）。
// 用法：node mine.mjs [--limit 20]

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { getProjectRoot, repoPath } from './lib/repo-paths.mjs';

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: getProjectRoot(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return '';
  }
};

const mineGitFixes = (limit) => {
  const log = git(['log', '--oneline', '-i', '--grep=fix', '--grep=bug', '--grep=修复', '--grep=回滚', '--grep=revert', `-n${Math.max(limit * 3, 60)}`]);
  return log.split('\n').filter(Boolean).slice(0, limit).map((line) => {
    const hash = line.slice(0, line.indexOf(' '));
    const subject = line.slice(line.indexOf(' ') + 1).trim();
    return {
      source: 'git-fix',
      title: `历史修复沉淀：${subject.slice(0, 60)}`,
      clarification: `该问题曾有真实修复（${hash}）。若属可复发的业务契约，请改写为「不得…」句式并挂 TC。`,
      evidence: `git:${hash}`
    };
  });
};

const mineInstructions = (limit) => {
  const candidates = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'README.md']) {
    const path = repoPath(name);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (candidates.length >= limit) return;
      if (/(不得|禁止|严禁|必须)/.test(line) && line.trim().length > 8) {
        candidates.push({
          source: 'instruction',
          title: line.trim().replace(/^[-*\d.\s]+/, '').slice(0, 60),
          clarification: `来自 ${name}:${index + 1} 的既有约定。请核实代码现状后确认（存量可能已违背——用「存量封顶、增量防护」句式改写）。`,
          evidence: `${name}:${index + 1}`
        });
      }
    });
  }
  return candidates;
};

const mineTodos = (limit) => {
  const out = git(['grep', '-n', '-E', 'TODO|FIXME', '--', 'src']);
  return out.split('\n').filter(Boolean).slice(0, limit).map((line) => ({
    source: 'todo',
    title: `隐性债务：${line.slice(line.indexOf(':') + 1).trim().slice(0, 50)}`,
    clarification: 'TODO/FIXME 常标记着未固化的业务约束——判断是否值得升格为 REQ。',
    evidence: line.slice(0, Math.max(line.indexOf(':'), 0) + 40)
  }));
};

const mineHotspots = (limit) => {
  const out = git(['log', '--numstat', '--format=', '-n', '300']);
  const counts = new Map();
  for (const line of out.split('\n')) {
    const match = line.match(/^\d+\s+\d+\s+(.+)$/);
    if (match) {
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([file, count]) => ({
    source: 'hotspot',
    title: `高频改动文件：${file}（近 300 次提交改动 ${count} 次）`,
    clarification: `建议为 ${file.startsWith('src/') ? file.split('/').slice(0, 3).join('/') : file} 初始化模块 harness，沉淀该区域的业务契约。`,
    evidence: `git-log-numstat:${file}`
  }));
};

const main = async () => {
  const limitIndex = process.argv.indexOf('--limit');
  const limit = limitIndex > -1 ? Number(process.argv[limitIndex + 1]) || 20 : 20;
  const perSourceLimit = limit;
  const candidates = [
    ...mineInstructions(perSourceLimit),
    ...mineGitFixes(perSourceLimit),
    ...mineTodos(Math.max(2, Math.floor(limit / 2))),
    ...mineHotspots(Math.max(2, Math.floor(limit / 2)))
  ].slice(0, limit * 4); // 每源保留名额：不让先到的源把总量挤占干净（hotspot/todo 至少各 2 席）

  // LLM 增强层（可选，fail-open）：对 instruction 候选润色澄清正文
  if (process.env.HARNESS_LLM_DRAFT === '1' && (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)) {
    try {
      const { llmReviewViolation } = await import('./lib/llm-critic.mjs');
      void llmReviewViolation; // 起草器复用 provider 探测；润色走下方轻量调用
      const config = (await import('./lib/llm-critic.mjs')).llmCriticConfig({ HARNESS_LLM_CRITIC: '1' });
      for (const candidate of candidates.filter((c) => c.source === 'instruction').slice(0, 5)) {
        try {
          const response = await fetch(config.provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : `${config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(config.provider === 'anthropic' ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${config.apiKey}` }) },
            body: JSON.stringify(config.provider === 'anthropic'
              ? { model: config.model, max_tokens: 300, messages: [{ role: 'user', content: `把以下项目约定改写为一条可验证的需求条款（不得句式+验证方式），只输出条款正文：${candidate.title}` }] }
              : { model: config.model, messages: [{ role: 'user', content: `把以下项目约定改写为一条可验证的需求条款（不得句式+验证方式），只输出条款正文：${candidate.title}` }] })
          });
          const data = await response.json();
          const text = config.provider === 'anthropic' ? data?.content?.[0]?.text : data?.choices?.[0]?.message?.content;
          if (text && text.trim()) candidate.clarification = `${candidate.clarification}\nLLM 起草：${text.trim().slice(0, 200)}`;
        } catch {}
      }
    } catch {}
  }

  for (const candidate of candidates) {
    process.stdout.write(`${JSON.stringify(candidate)}\n`);
  }

  // 草稿落 inbox/（人审后才可入库；check 不校验 inbox 内容）
  const inboxDir = repoPath('.agentdoc', 'harness', 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  const draftPath = repoPath('.agentdoc', 'harness', 'inbox', `mine-${new Date().toISOString().slice(0, 10)}.md`);
  const existing = existsSync(draftPath) ? readFileSync(draftPath, 'utf8') : '';
  const block = [
    `# mine 草稿（${new Date().toISOString().slice(0, 10)}，${candidates.length} 条候选）`,
    '',
    '> 人审后移入 modules/<模块>/（confidence 记 inferred，跑 reqbank confirm 升级）。mine 永不直接写 modules/。',
    '',
    ...candidates.map((c, i) => `${i + 1}. [${c.source}] ${c.title}\n   证据：${c.evidence}\n   ${c.clarification.replace(/\n/g, '\n   ')}`)
  ].join('\n');
  writeFileSync(draftPath, `${existing}${existing ? '\n\n' : ''}${block}\n`);
  process.stderr.write(`[reqbank mine] ${candidates.length} 条候选 → ${draftPath}（stdout 为 JSONL 流）\n`);
};

main().catch((error) => {
  console.error(`[reqbank mine] fatal: ${error.message}`);
  process.exit(0); // 挖掘是建议性操作：fail-open
});
