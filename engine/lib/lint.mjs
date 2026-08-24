// 脚手架内容 lint：堵两类静默失效。
// 1) 标签覆盖：REQ 的标签若未登记在所属模块任何命中路径行上，路径召回将永远跳过该条——静默漏检之源。
// 2) 矛盾条款对：同模块内共享主题词、极性相反的 REQ 对（一禁一立）——知识库内部相悖的哨兵。

import { join } from 'node:path';
import { extractCjkSignalGrams } from './critic-prompt.mjs';

// 与 harness-store 的 GENERIC_RECALL_TAGS 保持同集：通用标签不参与"必须登记在路径行"的强校验。
const GENERIC_RECALL_TAGS = new Set([
  'pcr', 'io', 'i18n', 'request', 'validation', 'save-payload', 'api-contract', 'ui-interaction'
]);

const PROHIBITION_BEFORE_SUBJECT = /(?:不|禁|无|勿|严禁)[^。；\n]{0,8}/;
const STRONG_PROHIBITION = /一律不|全部不|禁止展示|禁止使用|严禁/;

// 通用动词不做主题词：「展示/隐藏」这类词出现在任何 UI 条款里，会造成极性误报
const GENERIC_SUBJECT_STOPWORDS = new Set([
  '展示', '显示', '隐藏', '处理', '支持', '校验', '读取', '渲染', '更新', '提示', '状态', '页面', '组件', '数据'
]);

const cjkTitleSubjects = (title) =>
  extractCjkSignalGrams(String(title ?? '')).filter((gram) => gram.length >= 2 && !GENERIC_SUBJECT_STOPWORDS.has(gram));

const fullText = (record) => [
  record.title,
  record.clarification,
  record.tags?.join(' ')
].filter(Boolean).join('\n');

/**
 * 标签覆盖检查：返回 [{ scope, id, tag, module }]。
 * 规则：模块化 REQ 的每个非通用标签，都必须出现在该模块至少一条命中路径行的标签里；
 * 否则按现有召回算法，该条在纯路径触发场景下不可达。
 */
export const lintTagCoverage = ({ requirements, modulesWithMeta }) => {
  const problems = [];
  const tagsByModule = new Map();
  for (const module of modulesWithMeta) {
    const tags = new Set();
    for (const entry of module.paths ?? []) {
      for (const tag of entry.tags ?? []) {
        tags.add(tag);
      }
    }
    tagsByModule.set(module.name, tags);
  }
  for (const record of requirements) {
    if (record.scope === 'global') {
      continue; // 全局条目由 global/index.md 命中范围管理，另行人工维护
    }
    const moduleTags = tagsByModule.get(record.scope);
    if (!moduleTags) {
      continue; // 模块不存在属结构问题，由 check 结构项负责
    }
    for (const tag of record.tags ?? []) {
      if (!GENERIC_RECALL_TAGS.has(tag) && !moduleTags.has(tag)) {
        problems.push({
          scope: record.scope,
          id: record.id,
          tag,
          message: `标签 "${tag}" 未登记在模块 ${record.scope} 的任何命中路径行上——纯路径召回场景下 ${record.scope}:${record.id} 不可达`
        });
      }
    }
  }
  return problems;
};

/**
 * 矛盾条款对检查（保守启发式，只提示不判死）：
 * 同模块两条 REQ，标题共享同一主题词（2~3 字 CJK 片段），且恰好一方对该主题带强禁止表述、另一方为正向表述。
 * 返回 [{ a, b, subject }]。
 */
export const lintContradictions = (requirements) => {
  const byScope = new Map();
  for (const record of requirements) {
    if (!byScope.has(record.scope)) {
      byScope.set(record.scope, []);
    }
    byScope.get(record.scope).push(record);
  }
  const pairs = [];
  for (const [, records] of byScope) {
    for (let i = 0; i < records.length; i += 1) {
      for (let j = i + 1; j < records.length; j += 1) {
        const a = records[i];
        const b = records[j];
        const subjectsA = new Set(cjkTitleSubjects(a.title));
        const subjectsB = cjkTitleSubjects(b.title);
        const shared = subjectsB.filter((gram) => subjectsA.has(gram));
        if (!shared.length) {
          continue;
        }
        const textA = fullText(a);
        const textB = fullText(b);
        const isProhibited = (text, subject) =>
          STRONG_PROHIBITION.test(text)
          || new RegExp(`${PROHIBITION_BEFORE_SUBJECT.source.replace(/\)$/, '')}(?:${subject})`).test(text.replace(/[，,\s]/g, ''));
        // 至少一个共享主题词上呈现「一方禁止、一方正做」的极性对立
        const opposed = shared.some((subject) => {
          const aNeg = isProhibited(textA, subject);
          const bNeg = isProhibited(textB, subject);
          return aNeg !== bNeg;
        });
        if (opposed) {
          pairs.push({ a: `${a.scope}:${a.id}`, b: `${b.scope}:${b.id}`, subject: shared.join('/') });
        }
      }
    }
  }
  return pairs;
};
