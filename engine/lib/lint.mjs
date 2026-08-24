// 脚手架内容 lint：堵两类静默失效。
// 1) 标签覆盖：REQ 的标签若未登记在所属模块任何命中路径行上，路径召回将永远跳过该条——静默漏检之源。
// 2) 矛盾条款对：同模块内共享主题词、极性相反的 REQ 对（一禁一立）——知识库内部相悖的哨兵。

import { join } from 'node:path';
import { extractCjkSignalGrams, hasProhibitionSignal } from './critic-prompt.mjs';
import { getGenericRecallTags } from './harness-store.mjs';

// 与 harness-store 召回配置同集（真源「## 召回配置」节可覆盖）：通用标签不参与"必须登记在路径行"的强校验。
const GENERIC_RECALL_TAGS = getGenericRecallTags();

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

/**
 * 追溯完整性检查（P1 trace-integrity）：REQ↔TC 双向引用 + 铁律②（每 REQ 必挂 TC）+ 根索引与目录一致。
 * errors：悬挂引用（REQ→TC / TC→REQ 指向不存在的条目）、双向不对称链接。
 * warnings：无 TC 的 REQ（铁律②此前从未被机械化）、根 index「已建模块」与 modules/ 目录漂移。
 * 同 scope 校验：跨模块引用在数据模型上不可达（scope:id 才是全库身份），跨 scope 引用按悬挂报告。
 */
export const lintTraceIntegrity = ({ requirements, tests, moduleDirNames = [], registeredModuleNames = [] }) => {
  const errors = [];
  const warnings = [];
  const reqByScopeId = new Map(requirements.map((record) => [`${record.scope}:${record.id}`, record]));
  const tcByScopeId = new Map(tests.map((record) => [`${record.scope}:${record.id}`, record]));

  for (const req of requirements) {
    const reqKey = `${req.scope}:${req.id}`;
    if (!req.relatedTests?.length) {
      warnings.push(`${reqKey} 未挂任何 TC——铁律②（每条 REQ 必须挂可执行 TC）不满足`);
      continue;
    }
    for (const tcId of req.relatedTests) {
      const tcKey = `${req.scope}:${tcId}`;
      const tc = tcByScopeId.get(tcKey);
      if (!tc) {
        errors.push(`${reqKey} 悬挂 TC 引用：${tcKey} 不存在`);
        continue;
      }
      if (!(tc.relatedReqs ?? []).includes(req.id)) {
        errors.push(`双向不对称：${reqKey} 列出 ${tcKey}，但后者未反指 ${req.id}`);
      }
    }
  }
  for (const tc of tests) {
    for (const reqId of tc.relatedReqs ?? []) {
      const reqKey = `${tc.scope}:${reqId}`;
      if (!reqByScopeId.has(reqKey)) {
        errors.push(`${tc.scope}:${tc.id} 悬挂 REQ 引用：${reqKey} 不存在`);
      }
    }
  }

  const dirSet = new Set(moduleDirNames);
  const registeredSet = new Set(registeredModuleNames);
  for (const name of dirSet) {
    if (!registeredSet.has(name)) {
      warnings.push(`模块索引漂移：modules/${name} 存在，但根 index「已建模块」未登记（B9）`);
    }
  }
  for (const name of registeredSet) {
    if (!dirSet.has(name)) {
      warnings.push(`模块索引漂移：根 index「已建模块」登记的 ${name} 目录不存在（B9）`);
    }
  }
  return { errors, warnings };
};

/**
 * 生命周期检查（P3）：superseded 目标必须存在且为 active；取代链不得成环；
 * gap 置信度（代码无法判定）计入警告，--strict 下升级。
 */
export const lintLifecycle = (requirements) => {
  const errors = [];
  const warnings = [];
  const byScopeId = new Map(requirements.map((record) => [`${record.scope}:${record.id}`, record]));
  let gapCount = 0;
  let inferredCount = 0;
  for (const record of requirements) {
    if (record.confidence === 'gap') gapCount += 1;
    if (record.confidence === 'inferred') inferredCount += 1;
    if (record.status === 'superseded' && record.supersedes) {
      const targetKey = `${record.scope}:${record.supersedes}`;
      const target = byScopeId.get(targetKey);
      if (!target) {
        errors.push(`${record.scope}:${record.id} 的取代目标 ${targetKey} 不存在`);
      } else if (target.status !== 'active') {
        errors.push(`${record.scope}:${record.id} 取代了非 active 条款 ${targetKey}`);
      }
    }
  }
  // 取代链查环：A superseded> B、B superseded> A
  for (const record of requirements) {
    const seen = new Set([`${record.scope}:${record.id}`]);
    let current = record;
    while (current?.status === 'superseded' && current.supersedes) {
      const key = `${current.scope}:${current.supersedes}`;
      if (seen.has(key)) {
        errors.push(`取代链成环：${[...seen, key].join(' → ')}`);
        break;
      }
      seen.add(key);
      current = byScopeId.get(key);
    }
  }
  if (gapCount) warnings.push(`${gapCount} 条 gap 置信度条款（代码无法判定，需人工确认）`);
  if (inferredCount) warnings.push(`${inferredCount} 条 inferred 置信度条款（考古/推断产物，待 reqbank confirm 人审）`);
  return { errors, warnings };
};

/**
 * 漂移检测（P3 dead-path）：命中路径 glob 在工作区零匹配 → 条款变僵尸（warning）。
 * repoFiles 由调用方传入（check 一次性扫描）；HARNESS_DRIFT_SKIP=1 时调用方应跳过本检查。
 */
export const lintDeadPaths = ({ modulesWithMeta, repoFiles }) => {
  const warnings = [];
  for (const module of modulesWithMeta) {
    for (const entry of module.paths ?? []) {
      const alive = repoFiles.some((file) => {
        try {
          return module.paths ? matchGlob(file, entry.path) : false;
        } catch {
          return false;
        }
      });
      if (!alive) {
        warnings.push(`dead-path：模块 ${module.name} 的命中路径 \`${entry.path}\` 在工作区零匹配——文件已删除/改名，或条款变僵尸`);
      }
    }
  }
  return warnings;
};

const matchGlob = (file, pattern) => {
  if (pattern.endsWith('/') && file.startsWith(pattern)) return true;
  if (pattern.includes('**')) {
    const regex = new RegExp(`^${pattern.split('**').map((s) => s.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')).join('.*')}$`);
    return regex.test(file);
  }
  if (pattern.includes('*')) {
    const regex = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')}$`);
    return regex.test(file);
  }
  return file === pattern || file.startsWith(`${pattern}/`);
};

/**
 * 断言覆盖率（P2 compile-weak，warrant「模糊即拒」的渐进采用版）：
 * 含禁止语义（不得/禁止…）的 REQ 若未编译任何断言，只靠 n-gram 猜极性——提示补「## 断言」。
 * 永远只是提示（不 strict 升级）：存量条款渐进补齐，不强制阻塞。
 */
export const lintAssertionCoverage = (requirements) => requirements
  .filter((record) => hasProhibitionSignal(record) && !(record.assertions ?? []).length)
  .map((record) => `compile-weak: ${record.scope}:${record.id} 含禁止语义但未编译任何断言（「## 断言」节可配 no-delete/forbid-add/forbid-path 提高确定性拦截）`);
