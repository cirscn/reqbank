#!/usr/bin/env node
// LLM 增强 critic：捕获「新增式违反禁止类需求」。
// 确定性分类器只看删除侧守卫词的消失；纯新增代码去实施某条"不得/禁止"条款的行为它看不见。
// 本模块把此类候选条款交给 LLM 做极性判定（补丁是否实施了该条款禁止的行为）。
//
// 设计约束：
// - 默认关闭：HARNESS_LLM_CRITIC=1 显式开启
// - Provider 按环境变量自动探测：ANTHROPIC_API_KEY > OPENAI_API_KEY（兼容自定义 OPENAI_BASE_URL）
// - 无 key / 超时 / 解析失败一律 fail-open：返回原 verdict，不阻断流程
// - 可注入 fetchImpl 供离线测试

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoPath } from './repo-paths.mjs';

const SYSTEM_PROMPT = [
  '你是软件需求契约审计员。给定一条需求条款与一段代码补丁，',
  '只判断一件事：补丁是否实施了这条条款所禁止或警告的行为。',
  '注意：条款里的"不得/禁止/必须隐藏"等约束针对的是行为本身，与代码写法无关。',
  '严格输出单行 JSON，四个字段缺一不可：',
  '{"violation": true|false, "clause_quote": "从条款原文逐字摘录的关键句", "diff_quote": "从补丁里逐字摘录的证据行", "next_step": "不超过40字的下一步正确做法"}',
  '引文必须是原文的连续子串，不得改写、不得翻译。'
].join('');

export const llmCriticConfig = (env = process.env) => {
  const enabled = env.HARNESS_LLM_CRITIC === '1' || env.HARNESS_LLM_CRITIC === 'true';
  const anthropicKey = env.ANTHROPIC_API_KEY ?? '';
  const openaiKey = env.OPENAI_API_KEY ?? '';
  const provider = anthropicKey ? 'anthropic' : openaiKey ? 'openai' : null;
  return {
    enabled,
    provider,
    apiKey: anthropicKey || openaiKey,
    model: env.HARNESS_LLM_MODEL ?? (anthropicKey ? 'claude-sonnet-4-5' : 'gpt-4o-mini'),
    baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    timeoutMs: Number(env.HARNESS_LLM_TIMEOUT_MS ?? 20000),
    maxRecords: Number(env.HARNESS_LLM_MAX_RECORDS ?? 3)
  };
};

const buildUserPrompt = (record, diff) => {
  const clauses = [
    record.title,
    record.clarification,
    record.mustVerify ? `验证要求：${record.mustVerify}` : ''
  ].filter(Boolean).join('\n');
  return `【需求条款】\n${clauses}\n\n【代码补丁】\n${diff}\n\n该补丁是否实施了本条款禁止/警告的行为？`;
};

const parseVerdict = (text, { clauseSource = '', diffSource = '' } = {}) => {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.violation !== 'boolean') {
      return null;
    }
    const verdict = {
      violation: parsed.violation,
      reason: String(parsed.reason ?? parsed.next_step ?? '').slice(0, 120),
      clause_quote: String(parsed.clause_quote ?? ''),
      diff_quote: String(parsed.diff_quote ?? ''),
      next_step: String(parsed.next_step ?? '').slice(0, 80)
    };
    // 子串回验（P2）：模型幻觉的引文结构上到不了决策路径——
    // violation=true 时两条引文必须分别是条款原文/补丁原文的连续子串
    if (verdict.violation) {
      if (!verdict.clause_quote || !clauseSource.includes(verdict.clause_quote)) {
        return null;
      }
      if (!verdict.diff_quote || !diffSource.includes(verdict.diff_quote)) {
        return null;
      }
    }
    return verdict;
  } catch {
    return null;
  }
};

// 磁盘缓存：同条款+同补丁的判定不重复调用（HARNESS_LLM_CACHE=off 关闭）。
const cachePathFor = (record, diff) => {
  try {
    const key = createHash('sha256').update(`${record.scope}:${record.id}\n${diff}`).digest('hex');
    return join(repoPath('.agentdoc', 'harness', 'cache'), `llm-${key.slice(0, 24)}.json`);
  } catch {
    return null;
  }
};
const readCache = (path) => {
  if (!path || process.env.HARNESS_LLM_CACHE === 'off') {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};
const writeCache = (path, verdict) => {
  if (!path || process.env.HARNESS_LLM_CACHE === 'off' || !verdict) {
    return;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(verdict), 'utf8');
  } catch {
    // 缓存失败不影响主流程
  }
};

const callProvider = async ({ config, userPrompt, verifyCtx }, fetchImpl) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    let response;
    if (config.provider === 'anthropic') {
      response = await (fetchImpl ?? fetch)('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 200,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }]
        })
      });
    } else {
      response = await (fetchImpl ?? fetch)(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
          ]
        })
      });
    }
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const text = config.provider === 'anthropic'
      ? data?.content?.[0]?.text
      : data?.choices?.[0]?.message?.content;
    return parseVerdict(text, verifyCtx);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 对单条候选记录做 LLM 极性判定。任何失败路径返回 null（fail-open）。
 * 命中缓存（sha256(条款id+diff)）时零网络调用。
 */
export const llmReviewViolation = async ({ record, diff, config, fetchImpl } = {}) => {
  if (!config?.provider || !config.apiKey) {
    return null;
  }
  const cachePath = cachePathFor(record, diff);
  const cached = readCache(cachePath);
  if (cached) {
    return { ...cached, cached: true };
  }
  const clauseSource = buildUserPrompt(record, diff).split('【代码补丁】')[0];
  const userPrompt = buildUserPrompt(record, diff);
  const verdict = await callProvider({ config, userPrompt, verifyCtx: { clauseSource, diffSource: diff } }, fetchImpl);
  writeCache(cachePath, verdict);
  return verdict;
};

/**
 * 编排入口：在确定性 verdict 之上叠加 LLM 复核。
 * - 未启用 / 无 provider / 已是 critical → 原样返回
 * - 候选选择：被确定性分类为 weak 的记录中，条款含否定信号且新增侧与其证据集有交集者
 * - 判定 violation=true 只写入审计（llm.violations / notes），不升级 conflict、不硬拦。
 *   硬拦只认「## 断言」；LLM 是可选复核层，fail-open。
 */
export const applyLlmCritic = async ({ verdict, recalledReqs, diff, selectCandidates, config = llmCriticConfig(), fetchImpl } = {}) => {
  if (!config.enabled || !config.provider || !verdict || verdict.severity === 'critical') {
    return { verdict, llm: { enabled: Boolean(config.enabled), checked: [], violations: [], skippedReason: config.enabled ? undefined : 'disabled' } };
  }
  if (!selectCandidates || typeof selectCandidates !== 'function') {
    return { verdict, llm: { enabled: true, checked: [], violations: [], skippedReason: 'no-selector' } };
  }
  const candidates = (selectCandidates(recalledReqs, diff) ?? []).slice(0, config.maxRecords);
  const violations = [];
  const checked = [];
  let quoteRejections = 0;
  for (const candidate of candidates) {
    const outcome = await llmReviewViolation({ record: candidate.record, diff, config, fetchImpl });
    checked.push(`${candidate.record.scope}:${candidate.record.id}`);
    if (outcome?.cached) {
      checked[checked.length - 1] += '(cache)';
    }
    if (outcome === null) {
      quoteRejections += 1; // 含引文回验失败——幻觉判定被丢弃
    }
    if (outcome?.violation) {
      violations.push({
        id: `${candidate.record.scope}:${candidate.record.id}`,
        reason: outcome.reason,
        clause_quote: outcome.clause_quote,
        diff_quote: outcome.diff_quote,
        next_step: outcome.next_step
      });
    }
  }
  const next = { ...verdict };
  if (violations.length) {
    next.notes = `LLM critic（仅审计，不硬拦）: ${violations.map((item) => `${item.id}「${item.clause_quote.slice(0, 60)}」证据「${item.diff_quote.slice(0, 60)}」→ ${item.next_step}`).join('；')}`;
  }
  return {
    verdict: next,
    llm: {
      enabled: true,
      checked,
      violations,
      quote_rejections: quoteRejections,
      skippedReason: candidates.length ? undefined : 'no-candidates'
    }
  };
};
