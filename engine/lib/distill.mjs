#!/usr/bin/env node
// Stop 沉淀层：把本回合「改动但零模块覆盖」的证据自动落成 inbox 草稿卡；
// 可选 LLM（HARNESS_STOP_DISTILL=1）把 diff 摘要起草成「不得」句式 REQ 候选。
// 边界：只写 inbox/，永不写 modules/（人审先于入库）；不参与 block 判定，任何失败 fail-open。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoPath } from './repo-paths.mjs';
import { llmCriticConfig } from './llm-critic.mjs';

const MAX_FILES = 10;
const MAX_DIFF_CHARS = 12_000;
const MAX_DRAFTS = 3;

export const stopDistillConfig = (env = process.env) => {
  const base = llmCriticConfig(env);
  return {
    enabled: env.HARNESS_STOP_DISTILL === '1' || env.HARNESS_STOP_DISTILL === 'true',
    provider: base.provider,
    apiKey: base.apiKey,
    model: base.model,
    baseUrl: base.baseUrl,
    timeoutMs: base.timeoutMs
  };
};

const DRAFT_SYSTEM_PROMPT = [
  '你是软件需求契约整理员。给定一段代码补丁，提炼其中体现的、可长期复用的业务契约，',
  `输出 0-${MAX_DRAFTS} 条「不得」句式需求候选。严格输出单行 JSON 数组：`,
  '[{"title":"不超过40字、含否定语义的标题","clarification":"完整契约：不得做什么、边界与违反后果","tags":"逗号分隔标签"}]',
  '只依据补丁中可验证的行为，不猜测业务背景；没有值得沉淀的契约时输出 []。'
].join('\n');

const isDraftShape = (item) => (
  item
  && typeof item === 'object'
  && !Array.isArray(item)
  && typeof item.title === 'string'
  && item.title.trim().length > 0
  && item.title.length <= 80
  && typeof item.clarification === 'string'
  && /(不得|禁止|必须)/.test(item.clarification)
  && item.clarification.length <= 400
);

// 宽进严出：结构或句式不合格的候选整条丢弃，不让幻觉文本进人审队列。
const parseDraftCards = (text) => {
  const match = String(text ?? '').match(/\[[\s\S]*\]/);
  if (!match) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(isDraftShape).slice(0, MAX_DRAFTS).map((item) => ({
    kind: 'llm-draft',
    title: item.title.trim(),
    tags: String(item.tags ?? '').slice(0, 60),
    advice: `候选正文：${String(item.clarification).trim()}`
  }));
};

const llmDraftCandidates = async ({ digest, config }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const userPrompt = `【代码补丁】\n${digest}\n\n请按系统指令输出需求候选 JSON 数组。`;
    let response;
    if (config.provider === 'anthropic') {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 1000,
          system: DRAFT_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }]
        })
      });
    } else {
      response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: DRAFT_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
          ]
        })
      });
    }
    if (!response.ok) {
      return [];
    }
    const data = await response.json();
    const text = config.provider === 'anthropic'
      ? data?.content?.[0]?.text
      : data?.choices?.[0]?.message?.content;
    return parseDraftCards(text);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
};

const buildDiffDigest = (diffTexts) => {
  const entries = [...(diffTexts ?? []).entries()]
    .filter(([, text]) => typeof text === 'string' && text.trim())
    .slice(0, MAX_FILES);
  if (!entries.length) {
    return '';
  }
  let used = 0;
  const parts = [];
  for (const [file, text] of entries) {
    const remaining = MAX_DIFF_CHARS - used;
    if (remaining <= 0) break;
    const slice = text.slice(0, Math.floor(MAX_DIFF_CHARS / entries.length));
    used += slice.length + file.length;
    parts.push(`--- ${file} ---\n${slice}`);
  }
  return parts.join('\n');
};

// 同日同名卡片去重：Stop 每回合都跑，同一文件反复出现时不再追加重复卡。
const appendCardsOnce = ({ path, stamp, cards }) => {
  const fresh = (() => {
    if (!existsSync(path)) {
      return cards;
    }
    const existing = readFileSync(path, 'utf8');
    return cards.filter((card) => !existing.includes(card.title));
  })();
  if (!fresh.length) {
    return [];
  }
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const header = existing
    ? ''
    : [`# Stop 自动沉淀（${stamp}）`, '', '> 由 Stop 钩子自动生成；人审后按 agent-guide 五步协议落为 REQ/TC。', ''].join('\n');
  const body = [
    ...(header ? [header] : []),
    ...fresh.map((card, index) => [
      `${index + 1}. [${card.kind}] ${card.title}`,
      `   标签：${card.tags || '-'}`,
      `   建议：${card.advice}`
    ].join('\n'))
  ].join('\n');
  writeFileSync(path, `${existing}${existing ? '\n\n' : ''}${body}\n`, 'utf8');
  return fresh.map((card) => card.title);
};

/**
 * Stop 时沉淀入口（fail-open，绝不抛错到调用方的执法路径之外）：
 * - uncoveredFiles 非空 → 确定性「零覆盖」卡片（始终启用，无网络调用）
 * - HARNESS_STOP_DISTILL=1 且探测到 provider → 用 diff 摘要起草 REQ 候选
 */
export const runStopDistill = async ({ uncoveredFiles = [], diffTexts = new Map(), env = process.env } = {}) => {
  const result = {
    deterministic_cards: [],
    llm_drafts: [],
    llm_enabled: false,
    skipped_reason: null
  };
  const files = [...new Set(uncoveredFiles)].filter(Boolean).slice(0, MAX_FILES);
  const config = stopDistillConfig(env);
  result.llm_enabled = Boolean(config.enabled && config.provider);

  const wantLlm = result.llm_enabled && (diffTexts instanceof Map) && diffTexts.size > 0;
  if (!files.length && !wantLlm) {
    result.skipped_reason = config.enabled && !config.provider
      ? 'no_provider'
      : result.llm_enabled ? 'llm_enabled_but_no_diffs' : 'nothing_to_distill';
    return result;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const path = repoPath('.agentdoc', 'harness', 'inbox', `stop-${stamp}.md`);
  const cards = files.map((file) => ({
    kind: 'stop-uncovered',
    title: `本回合改动未命中任何模块：${file}`,
    tags: '',
    advice: '该文件不在任何模块命中路径内——初始化模块 harness 或登记进 index.md「待初始化高风险模块」（agent-guide 五步协议）。'
  }));

  if (wantLlm) {
    const draftCards = await llmDraftCandidates({ digest: buildDiffDigest(diffTexts), config });
    result.llm_drafts = appendCardsOnce({ path, stamp, cards: draftCards });
  }
  // 确定性卡片后写：LLM 起草失败不影响零覆盖证据沉淀。
  result.deterministic_cards = appendCardsOnce({
    path,
    stamp,
    cards: files.length ? cards : []
  });
  return result;
};
