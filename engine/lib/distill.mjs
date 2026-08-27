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
const MAX_MODULE_DRAFTS = 3;
const MAX_EVIDENCE_PER_DRAFT = 40;
const MAX_HIT_PATHS_PER_DRAFT = 8;

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

// ── 模块候选自动起草（P6）：把零覆盖改动按目录聚成「待激活」模块草稿 ──
// 边界与卡片沉淀一致：只写 inbox/module-drafts/，永不写 modules/（人审先于入库）；
// 同名模块已注册时跳过；跨回合增量累积证据文件，草稿整体重写保证幂等。

// 粗粒度分组：src/apps/<app> 一档（整个应用一个候选），src/<top> 一档，其余取前两段。
const inferCoarseScope = (file) => {
  const segments = file.split('/');
  if (segments[0] === 'src' && segments[1] === 'apps') {
    return segments.slice(0, 3).join('/');
  }
  return segments.slice(0, 2).join('/');
};

const slugForScope = (scope) => scope.replace(/^src\//, '').replace(/\//g, '-');

// 从已有草稿的「证据文件」段提取文件列表（`- \`path\`` 行），供跨回合累积。
const readDraftEvidence = (content) => {
  const section = String(content ?? '').split(/^## /m).find((part) => part.startsWith('证据文件'));
  if (!section) {
    return [];
  }
  return [...new Set([...section.matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]))];
};

export const writeModuleDrafts = ({ files, stamp }) => {
  const groups = new Map();
  for (const file of files) {
    const scope = inferCoarseScope(file);
    if (!groups.has(scope)) {
      groups.set(scope, new Set());
    }
    groups.get(scope).add(file);
  }
  const written = [];
  for (const [scope, fileSet] of groups) {
    if (written.length >= MAX_MODULE_DRAFTS) {
      break;
    }
    const slug = slugForScope(scope);
    if (existsSync(repoPath('.agentdoc', 'harness', 'modules', slug))) {
      continue; // 同名模块已注册：草稿无意义，跳过
    }
    const draftPath = join(repoPath('.agentdoc', 'harness', 'inbox', 'module-drafts'), `${slug}.md`);
    const evidence = [...new Set([
      ...readDraftEvidence(existsSync(draftPath) ? readFileSync(draftPath, 'utf8') : ''),
      ...fileSet
    ])].slice(0, MAX_EVIDENCE_PER_DRAFT);
    // 命中路径取证据文件的直接父目录（比粗粒度 scope 更精准，召回不误伤兄弟目录）
    const hitPaths = [...new Set(evidence.map((file) => `${dirname(file)}/`))].slice(0, MAX_HIT_PATHS_PER_DRAFT);
    const tags = [...new Set(hitPaths
      .flatMap((path) => path.split('/'))
      .filter((segment) => segment && segment !== 'src' && segment !== 'apps'))].slice(0, 6);
    const tagText = tags.join(',') || 'general';
    const lines = [
      `# 模块候选：${slug}（自动起草 · 待人审激活）`,
      '',
      `> 由 Stop 钩子基于真实改动自动生成/增量维护，最近刷新：${stamp}。`,
      '> 本文件只是草稿：激活前不参与召回，任何钩子都不会匹配它。',
      '',
      `## 证据文件（累计 ${evidence.length} 个）`,
      '',
      ...evidence.map((file) => `- \`${file}\``),
      '',
      '## 建议命中路径（人审裁剪后粘进模块 index.md）',
      '',
      ...hitPaths.map((path) => `- \`${path}\` [strong] | ${tagText}`),
      '',
      '## 激活步骤（人审通过后）',
      '',
      `1. \`mkdir -p .agentdoc/harness/modules/${slug} && cp .agentdoc/harness/modules/_template/* .agentdoc/harness/modules/${slug}/\``,
      `2. 把上方「建议命中路径」按需裁剪后粘进 \`modules/${slug}/index.md\` 的「命中路径」。`,
      `3. 在 \`.agentdoc/harness/index.md\` 的「已建模块」登记一行：\`${slug} | .agentdoc/harness/modules/${slug}/ | ${tagText}\`。`,
      `4. 按 agent-guide 五步协议补 REQ/TC（证据文件对应的 inbox/stop-*.md 草稿卡可直接改写），跑 \`node .harness/bin/harness.mjs scope "自验任务"\` 确认可召回。`,
      '5. 激活后删除本草稿文件。',
      ''
    ];
    mkdirSync(dirname(draftPath), { recursive: true });
    writeFileSync(draftPath, lines.join('\n'), 'utf8');
    written.push({
      slug,
      path: `.agentdoc/harness/inbox/module-drafts/${slug}.md`,
      evidence_count: evidence.length,
      hit_paths: hitPaths
    });
  }
  return written;
};

/**
 * Stop 时沉淀入口（fail-open，绝不抛错到调用方的执法路径之外）：
 * - uncoveredFiles 非空 → 确定性「零覆盖」卡片 + 模块候选自动起草（始终启用，无网络调用）
 * - HARNESS_STOP_DISTILL=1 且探测到 provider → 用 diff 摘要起草 REQ 候选
 */
export const runStopDistill = async ({ uncoveredFiles = [], diffTexts = new Map(), env = process.env } = {}) => {
  const result = {
    deterministic_cards: [],
    llm_drafts: [],
    module_drafts: [],
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

  // 模块候选自动起草：失败不影响卡片沉淀（fail-open）。
  let moduleDrafts = [];
  if (files.length) {
    try {
      moduleDrafts = writeModuleDrafts({ files, stamp });
    } catch (error) {
      process.stderr.write(`[harness distill] module draft skipped: ${error.message}\n`);
    }
  }
  result.module_drafts = moduleDrafts;

  const draftBySlug = new Map(moduleDrafts.map((draft) => [draft.slug, draft]));
  const cards = files.map((file) => {
    const draft = draftBySlug.get(slugForScope(inferCoarseScope(file)));
    const advice = draft
      ? `该文件不在任何模块命中路径内——模块候选已自动起草：${draft.path}（累计证据 ${draft.evidence_count} 个文件），人审后按草稿内步骤激活。`
      : '该文件不在任何模块命中路径内——初始化模块 harness 或登记进 index.md「待初始化高风险模块」（agent-guide 五步协议）。';
    return {
      kind: 'stop-uncovered',
      title: `本回合改动未命中任何模块：${file}`,
      tags: '',
      advice
    };
  });

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
