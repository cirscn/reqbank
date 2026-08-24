// Parse .agentdoc/harness/ structure into recall-able records.
// Recall hook uses this to grep REQ/TC by task keywords; finalize hook uses
// this to verify diff coverage of recalled rules.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot, repoPath } from './repo-paths.mjs';

const HARNESS_ROOT = repoPath('.agentdoc', 'harness');

const readText = (path) => readFileSync(path, 'utf8');

// 解析期警告/错误收集：钩子路径静默忽略（不打扰会话），`reqbank check` 消费后呈现。
// kind: 'error' 使 check 失败；'warning' 仅提示（如未识别段名——可能是文档漂移）。
const parseWarnings = [];
export const consumeParseWarnings = () => {
  const warnings = [...parseWarnings];
  parseWarnings.length = 0;
  return warnings;
};

const REQ_SECTIONS = new Set(['索引', '需求澄清', '注意事项']);
const TEST_SECTIONS = new Set(['索引', '内容索引', '测试用例']);

const parseRequirements = (file, scope) => {
  if (!existsSync(file)) {
    return [];
  }
  const records = [];
  let currentSection = '';
  const indexMap = new Map();
  const clarifications = new Map();

  for (const line of readText(file).split('\n')) {
    if (line.startsWith('## ')) {
      currentSection = line.replace(/^##\s+/, '').trim();
      if (currentSection && !REQ_SECTIONS.has(currentSection)) {
        parseWarnings.push({ kind: 'warning', code: 'unknown-section', message: `${file} 出现未识别段名「## ${currentSection}」（已知：${[...REQ_SECTIONS].join('、')}）——该段下条目不会被解析` });
      }
      continue;
    }
    if (currentSection === '索引') {
      const match = line.match(/^(G?REQ-\d{3,})\s\|\s([^|]+)\s\|\s([^|]+)\s\|\s(.+)/);
      if (match) {
        if (indexMap.has(match[1])) {
          parseWarnings.push({ kind: 'error', code: 'duplicate-id', message: `${scope}:${match[1]} 索引行重复定义（后写覆盖先写，先写条目丢失）——${file}` });
        }
        indexMap.set(match[1], {
          id: match[1],
          tags: match[2].split(',').map((tag) => tag.trim()).filter(Boolean),
          relatedTests: match[3].split(',').map((id) => id.trim()).filter(Boolean),
          title: match[4].trim()
        });
      }
    }
    if (currentSection === '需求澄清') {
      const match = line.match(/^(G?REQ-\d{3,}):\s+(.+)/);
      if (match) {
        clarifications.set(match[1], match[2].trim());
      }
    }
  }

  for (const [id, entry] of indexMap) {
    records.push({
      ...entry,
      scope,
      file,
      clarification: clarifications.get(id) ?? ''
    });
  }
  return records;
};

const splitCompactExpect = (text) => {
  return text
    .split(/[；;]/)
    .map((item) => item.trim())
    .filter(Boolean);
};

const parseCompactTestLine = (line) => {
  const match = line.match(/^(G?TC-\d{3,}):\s+G=(.+?)\s+\|\s+W=(.+?)\s+\|\s+E=(.+?)\s+\|\s+V=(.+)$/);
  if (!match) {
    return null;
  }
  return {
    id: match[1],
    given: [match[2].trim()],
    when: [match[3].trim()],
    expect: splitCompactExpect(match[4]),
    verify: [match[5].trim()],
    trigger: match[3].trim(),
    mustVerify: match[4].trim()
  };
};

const parseTests = (file, scope) => {
  if (!existsSync(file)) {
    return [];
  }
  const records = [];
  let currentSection = '';
  const indexMap = new Map();
  const cases = new Map();

  for (const line of readText(file).split('\n')) {
    if (line.startsWith('## ')) {
      currentSection = line.replace(/^##\s+/, '').trim();
      if (currentSection && !TEST_SECTIONS.has(currentSection)) {
        parseWarnings.push({ kind: 'warning', code: 'unknown-section', message: `${file} 出现未识别段名「## ${currentSection}」（已知：${[...TEST_SECTIONS].join('、')}）——该段下条目不会被解析` });
      }
      continue;
    }
    // 「## 索引」是 requirements.md 的段名；tests.md 曾长期用同名段（README/llms.txt 旧示例），
    // 为避免照旧文档写的 TC 静默解析为零条，这里双段名兼容。
    if (currentSection === '内容索引' || currentSection === '索引') {
      const match = line.match(/^(G?TC-\d{3,})\s\|\s([^|]+)\s\|\s([^|]+)\s\|\s(.+)/);
      if (match) {
        if (indexMap.has(match[1])) {
          parseWarnings.push({ kind: 'error', code: 'duplicate-id', message: `${scope}:${match[1]} 内容索引行重复定义（后写覆盖先写，先写条目丢失）——${file}` });
        }
        indexMap.set(match[1], {
          id: match[1],
          tags: match[2].split(',').map((tag) => tag.trim()).filter(Boolean),
          relatedReqs: match[3].split(',').map((id) => id.trim()).filter(Boolean),
          title: match[4].trim()
        });
      }
    }
    if (currentSection === '测试用例') {
      const trimmedLine = line.trim();
      const compactTest = parseCompactTestLine(trimmedLine);
      if (compactTest) {
        cases.set(compactTest.id, {
          trigger: compactTest.trigger,
          mustVerify: compactTest.mustVerify,
          given: compactTest.given,
          when: compactTest.when,
          expect: compactTest.expect,
          verify: compactTest.verify
        });
      }
    }
  }

  for (const [id, entry] of indexMap) {
    const testCase = cases.get(id) ?? { trigger: '', mustVerify: '', given: [], when: [], expect: [], verify: [] };
    if (!testCase.trigger && testCase.when?.length) {
      testCase.trigger = testCase.when.join('；');
    }
    if (!testCase.mustVerify && testCase.expect?.length) {
      testCase.mustVerify = testCase.expect.join('；');
    }
    records.push({
      ...entry,
      scope,
      file,
      ...testCase
    });
  }
  return records;
};

const listModuleDirs = () => {
  const modulesRoot = join(HARNESS_ROOT, 'modules');
  if (!existsSync(modulesRoot)) {
    return [];
  }
  return readdirSync(modulesRoot)
    .map((entry) => join(modulesRoot, entry))
    .filter((path) => statSync(path).isDirectory())
    .filter((path) => !path.endsWith('/_template'));
};

// 解析模块 index.md 命中路径行：
//   - src/foo/                         -> { path: 'src/foo/', strength: 'strong', tags: [] }
//   - `src/foo/` [strong]              -> { path: 'src/foo/', strength: 'strong', tags: [] }
//   - `src/foo/` [strong] | tag-a,tag-b -> { path: 'src/foo/', strength: 'strong', tags: ['tag-a', 'tag-b'] }
// 无标记默认 strong（向后兼容）；strong/weak 必须小写。
export const parseHitPathLine = (line) => {
  if (!line.startsWith('- ')) {
    return null;
  }
  const inner = line.slice(2).trim();
  if (!inner) {
    return null;
  }
  const [pathPart, tagPart = ''] = inner.split(/\s*\|\s*/, 2);
  const markerMatch = pathPart.match(/\s+\[(strong|weak)\]\s*$/);
  let pathRaw;
  let strength = 'strong';
  if (markerMatch) {
    pathRaw = pathPart.slice(0, markerMatch.index).trim();
    strength = markerMatch[1];
  } else {
    pathRaw = pathPart;
  }
  const path = pathRaw.replace(/^`|`$/g, '').trim();
  if (!path) {
    return null;
  }
  const tags = tagPart
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  return { path, strength, tags };
};

export const getModuleHitPaths = (moduleDir) => {
  const indexPath = join(moduleDir, 'index.md');
  if (!existsSync(indexPath)) {
    return [];
  }
  const entries = [];
  let inSection = false;
  for (const line of readText(indexPath).split('\n')) {
    if (line.startsWith('## ')) {
      inSection = line.replace(/^##\s+/, '').trim() === '命中路径';
      continue;
    }
    if (inSection) {
      const parsed = parseHitPathLine(line);
      if (parsed) {
        entries.push(parsed);
      }
    }
  }
  return entries;
};

export const getGlobalHitPaths = () => {
  const indexPath = join(HARNESS_ROOT, 'global', 'index.md');
  if (!existsSync(indexPath)) {
    return [];
  }
  const entries = [];
  let inSection = false;
  for (const line of readText(indexPath).split('\n')) {
    if (line.startsWith('## ')) {
      inSection = line.replace(/^##\s+/, '').trim() === '命中范围';
      continue;
    }
    if (inSection) {
      const parsed = parseHitPathLine(line);
      if (parsed) {
        entries.push(parsed);
      }
    }
  }
  return entries;
};

export const loadAllRequirements = () => {
  const records = parseRequirements(join(HARNESS_ROOT, 'global', 'requirements.md'), 'global');
  for (const moduleDir of listModuleDirs()) {
    const name = moduleDir.split('/').pop();
    records.push(...parseRequirements(join(moduleDir, 'requirements.md'), name));
  }
  return records;
};

export const loadAllTests = () => {
  const records = parseTests(join(HARNESS_ROOT, 'global', 'tests.md'), 'global');
  for (const moduleDir of listModuleDirs()) {
    const name = moduleDir.split('/').pop();
    records.push(...parseTests(join(moduleDir, 'tests.md'), name));
  }
  return records;
};

export const listModulesWithMeta = () => {
  return [{
    name: 'global',
    dir: join(HARNESS_ROOT, 'global'),
    paths: getGlobalHitPaths()
  }, ...listModuleDirs().map((dir) => ({
    name: dir.split('/').pop(),
    dir,
    paths: getModuleHitPaths(dir)
  }))];
};

export const listPendingModules = () => {
  const indexPath = join(HARNESS_ROOT, 'index.md');
  if (!existsSync(indexPath)) {
    return [];
  }
  const pendings = [];
  let inSection = false;
  for (const line of readText(indexPath).split('\n')) {
    if (line.startsWith('## ')) {
      inSection = line.replace(/^##\s+/, '').trim() === '待初始化高风险模块';
      continue;
    }
    if (inSection && line.includes('|')) {
      const parts = line.split('|').map((part) => part.trim());
      if (parts.length >= 3) {
        pendings.push({
          name: parts[0],
          paths: parts[1].split(',').map((path) => path.trim()).filter(Boolean),
          tags: parts[2].split(',').map((tag) => tag.trim()).filter(Boolean)
        });
      }
    }
  }
  return pendings;
};

const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '或', '与', '把', '从', '给', '到', '为', '以', '及',
  '一', '一个', '请', '帮', '我', '我们', '你', '它', '这', '那', '什么', '怎么',
  '修复', '修改', '实现', '新增', '删除', '调整', '处理', '改动', '更改', '变更',
  '说明', '更新', '文档', '描述',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for',
  'of', 'and', 'or', 'but', 'with', 'from', 'this', 'that', 'it', 'be', 'as',
  'do', 'does', 'did', 'have', 'has', 'had', 'can', 'could', 'should', 'would',
  'fix', 'implement', 'add', 'remove', 'update', 'change', 'please', 'help', 'me', 'us', 'i', 'you'
]);

const CJK_EDGE_STOPWORDS = ['的', '了', '是', '在', '和', '或', '与', '把', '从', '给', '到', '为', '以', '及', '请', '帮'];

/** 修剪 CJK 串两端的停用字（如「的错误提示」→「错误提示」）。 */
const trimCjkEdges = (run) => {
  let core = run;
  let changed = true;
  while (changed && core.length > 2) {
    changed = false;
    for (const stop of CJK_EDGE_STOPWORDS) {
      if (core.startsWith(stop) && core.length - stop.length >= 2) {
        core = core.slice(stop.length);
        changed = true;
      }
      if (core.endsWith(stop) && core.length - stop.length >= 2) {
        core = core.slice(0, -stop.length);
        changed = true;
      }
    }
  }
  return core;
};

/**
 * 从 CJK 连续串生成检索粒度：修剪停用边的整串 + 2~4 字滑窗。
 * 「的错误提示去重问题」→ 错误提示去重问题 / 错误 / 误提 / 提示 / 示去 / 去重 / …（过滤纯停用字）
 */
export const extractCjkGrams = (text) => {
  const grams = new Set();
  for (const match of text.matchAll(/[一-鿿]{2,}/g)) {
    const core = trimCjkEdges(match[0]);
    if (core.length < 2 || STOPWORDS.has(core)) {
      continue;
    }
    grams.add(core);
    const windowMax = Math.min(4, core.length);
    for (let size = 2; size <= windowMax; size += 1) {
      for (let start = 0; start + size <= core.length; start += 1) {
        const gram = core.slice(start, start + size);
        if (!STOPWORDS.has(gram)) {
          grams.add(gram);
        }
      }
    }
  }
  return [...grams];
};

export const extractKeywords = (text) => {
  if (!text) {
    return [];
  }
  const cleaned = text.replace(/[`*_~#>\[\](){}!?,;。、，；：:]+/g, ' ');
  const tokens = cleaned
    .split(/[\s\n\r\t]+/)
    .map((token) => token.toLowerCase().trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !STOPWORDS.has(token));
  return Array.from(new Set([...tokens, ...extractCjkGrams(cleaned)]));
};

const FIELD_WEIGHTS = [
  { fields: ['title', 'tags'], weight: 3 },
  { fields: ['clarification', 'trigger'], weight: 2 },
  { fields: ['mustVerify', 'given', 'when', 'expect', 'verify'], weight: 1 }
];

export const scoreRecord = (record, keywords) => {
  if (!keywords.length) {
    return 0;
  }
  const scopeName = String(record.scope ?? '').toLowerCase();
  const buckets = FIELD_WEIGHTS.map(({ fields }) =>
    fields
      .map((field) => (Array.isArray(record[field]) ? record[field].join(' ') : record[field]))
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
  );
  let score = 0;
  for (const keyword of keywords) {
    const needle = keyword.toLowerCase();
    // 域名命中是最强信号：任务提到 useFetch 应直接拉起 usefetch 模块的记录。
    if (scopeName && (needle === scopeName || scopeName.includes(needle) || (needle.length >= 4 && needle.includes(scopeName)))) {
      score += 4;
    }
    FIELD_WEIGHTS.forEach(({ fields }, index) => {
      void fields;
      if (buckets[index].includes(needle)) {
        score += FIELD_WEIGHTS[index].weight;
      }
    });
  }
  return score;
};

const expandRecallKeywords = (keywords) => {
  const expanded = new Set(keywords);
  const addIfPresent = (needles, synonyms) => {
    if (needles.some((needle) => expanded.has(needle))) {
      for (const synonym of synonyms) {
        expanded.add(synonym);
      }
    }
  };
  addIfPresent(['ratio', '占比', '百分比'], ['ratio', '占比', '百分比']);
  addIfPresent(['contribution', '贡献', '贡献度'], ['contribution', '贡献', '贡献度']);
  addIfPresent(['cut', 'off', 'cut-off', 'cutoff'], ['cut', 'off', 'cut-off', 'cutoff']);
  return [...expanded];
};

const scopedRecordId = (record) => `${record.scope}:${record.id}`;

const GENERIC_RECALL_TAGS = new Set([
  'pcr',
  'io',
  'i18n',
  'request',
  'validation',
  'save-payload',
  'api-contract',
  'ui-interaction'
]);

export const recallByKeywords = (keywords, { topK = 3 } = {}) => {
  const expandedKeywords = expandRecallKeywords(keywords);
  const reqs = loadAllRequirements();
  const tests = loadAllTests();
  const all = [...reqs, ...tests];
  return all
    .map((record) => ({ record, score: scoreRecord(record, expandedKeywords) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((entry) => entry.record);
};

const normalizePathCandidate = (value) => {
  const cleaned = value
    .replace(/^["'`(（\[]+/, '')
    .replace(/["'`),，。；;:：\]]+$/, '')
    .replace(/^\.\/+/, '');
  const projectPrefix = `${getProjectRoot().replaceAll('\\', '/')}/`;
  if (cleaned.startsWith(projectPrefix)) {
    return cleaned.slice(projectPrefix.length);
  }
  return cleaned;
};

export const extractPathCandidates = (text) => {
  if (!text) {
    return [];
  }
  const candidates = [];
  const urlPattern = /https?:\/\/[^\s"'`),，。；;]+/g;
  for (const match of text.matchAll(urlPattern)) {
    try {
      const url = new URL(match[0]);
      if (url.pathname && url.pathname !== '/') {
        candidates.push(normalizePathCandidate(url.pathname));
      }
    } catch {
      // Keep URL parsing best-effort; the generic path matcher below still handles plain paths.
    }
  }

  const pathPattern = /(?:^|[\s"'`(（\[])([.\w@/-]+(?:\/[.\w@/*-]+)+|[.\w@/-]+\.(?:tsx?|jsx?|json|md|mjs|cjs))/g;
  for (const match of text.matchAll(pathPattern)) {
    const candidate = normalizePathCandidate(match[1]);
    if (candidate && !candidate.startsWith('http')) {
      candidates.push(candidate);
    }
  }
  return Array.from(new Set(candidates));
};

const matchPathPattern = (filePath, pattern) => {
  if (pattern.endsWith('/') && filePath.startsWith(pattern)) {
    return true;
  }
  if (pattern.includes('*')) {
    const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')}$`);
    return regex.test(filePath);
  }
  return filePath === pattern || filePath.startsWith(`${pattern}/`);
};

// 对单个 file 找出所有命中的模块及其命中强度；同模块多路径命中时优先 strong。
const findAllModuleMatches = (filePath) => {
  const matches = [];
  for (const module of listModulesWithMeta()) {
    let matchedStrength = null;
    const matchedTags = new Set();
    for (const entry of module.paths) {
      if (matchPathPattern(filePath, entry.path)) {
        matchedStrength = matchedStrength === 'strong' ? 'strong' : entry.strength;
        for (const tag of entry.tags ?? []) {
          matchedTags.add(tag);
        }
      }
    }
    if (matchedStrength) {
      matches.push({ module, strength: matchedStrength, tags: [...matchedTags] });
    }
  }
  return matches;
};

// 对每条 path 累积所有命中模块的强弱计数。仅当模块至少有 1 条 strong 命中才召回；
// 纯 weak 命中视为未命中（避免如 `LcaModeling/` 这类大目录被多模块误召回）。
export const recallByPaths = (paths, { topK = 3, keywords = [] } = {}) => {
  const expandedKeywords = expandRecallKeywords(keywords);
  const moduleStrengths = new Map();
  for (const path of paths) {
    for (const matched of findAllModuleMatches(path)) {
      const name = matched.module.name;
      if (!moduleStrengths.has(name)) {
        moduleStrengths.set(name, { strong: 0, weak: 0, tags: new Set() });
      }
      moduleStrengths.get(name)[matched.strength] += 1;
      for (const tag of matched.tags ?? []) {
        moduleStrengths.get(name).tags.add(tag);
      }
    }
  }

  const validModules = new Set();
  const moduleScores = new Map();
  const modulePathTags = new Map();
  for (const [name, counts] of moduleStrengths) {
    if (counts.strong > 0) {
      validModules.add(name);
      moduleScores.set(name, counts.strong * 10 + counts.weak);
      modulePathTags.set(name, counts.tags);
    }
  }
  if (!validModules.size) {
    return [];
  }

  const all = [...loadAllRequirements(), ...loadAllTests()];
  const scored = all
    .filter((record) => validModules.has(record.scope))
    .map((record, index) => {
      const pathTags = modulePathTags.get(record.scope) ?? new Set();
      const matchedTagCount = (record.tags ?? []).filter((tag) => pathTags.has(tag)).length;
      const specificMatchedTagCount = (record.tags ?? []).filter((tag) =>
        pathTags.has(tag) && !GENERIC_RECALL_TAGS.has(tag)
      ).length;
      const tagScore = Math.min(specificMatchedTagCount || matchedTagCount, 2) * 3;
      const keywordScore = scoreRecord(record, expandedKeywords);
      return {
        record,
        index,
        matchedTagCount,
        specificMatchedTagCount,
        tagScore,
        keywordScore,
        score: (moduleScores.get(record.scope) ?? 0) + keywordScore * 8 + tagScore
      };
    });
  const strongKeywordThreshold = expandedKeywords.length >= 2 ? 2 : 1;
  const keywordMatched = scored.filter((entry) => {
    if (entry.keywordScore < strongKeywordThreshold) {
      return false;
    }
    const pathTags = modulePathTags.get(entry.record.scope) ?? new Set();
    const hasSpecificPathTags = [...pathTags].some((tag) => !GENERIC_RECALL_TAGS.has(tag));
    return !pathTags.size || entry.specificMatchedTagCount > 0 || (!hasSpecificPathTags && entry.matchedTagCount > 0);
  });
  const tagMatched = scored.filter((entry) => {
    const pathTags = modulePathTags.get(entry.record.scope) ?? new Set();
    const requiredTagCount = entry.record.scope === 'global' && pathTags.size >= 2 ? 2 : 1;
    const hasSpecificPathTags = [...pathTags].some((tag) => !GENERIC_RECALL_TAGS.has(tag));
    if (hasSpecificPathTags) {
      return entry.specificMatchedTagCount >= requiredTagCount;
    }
    return entry.matchedTagCount >= requiredTagCount;
  });
  const signalMatched = [...keywordMatched, ...tagMatched].filter((entry, index, entries) =>
    entries.findIndex((candidate) => scopedRecordId(candidate.record) === scopedRecordId(entry.record)) === index
  );
  const ranked = signalMatched.length || validModules.has('global') ? signalMatched : scored;
  const sortedEntries = ranked
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.keywordScore !== left.keywordScore) {
        return right.keywordScore - left.keywordScore;
      }
      if (right.tagScore !== left.tagScore) {
        return right.tagScore - left.tagScore;
      }
      if (right.specificMatchedTagCount !== left.specificMatchedTagCount) {
        return right.specificMatchedTagCount - left.specificMatchedTagCount;
      }
      if (right.matchedTagCount !== left.matchedTagCount) {
        return right.matchedTagCount - left.matchedTagCount;
      }
      return scopedRecordId(left.record).localeCompare(scopedRecordId(right.record)) || left.index - right.index;
    });
  const picked = sortedEntries.slice(0, topK).map((entry) => entry.record);
  // global 纪律条款保底一席：命中路径触发的召回里，模块记录关键词分普遍更高，
  // 不保底时 global 条款会被整段挤出 topK，违背「始终读 global/index.md」的语义。
  if (validModules.has('global') && picked.length >= topK && !picked.some((record) => record.scope === 'global')) {
    const bestGlobal = sortedEntries.find((entry) => entry.record.scope === 'global');
    if (bestGlobal) {
      picked[picked.length - 1] = bestGlobal.record;
    }
  }
  return picked;
};

export const matchPendingModulesByPath = (filePath) => {
  const pendingModules = listPendingModules();
  for (const module of pendingModules) {
    for (const pattern of module.paths) {
      if (pattern.endsWith('/') && filePath.startsWith(pattern)) {
        return module;
      }
      if (pattern.includes('*')) {
        const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')}$`);
        if (regex.test(filePath)) {
          return module;
        }
      }
      if (filePath === pattern || filePath.startsWith(`${pattern}/`)) {
        return module;
      }
    }
  }
  return null;
};

export const recallPendingModulesByPaths = (paths, { topK = 5 } = {}) => {
  const modules = [];
  const seen = new Set();
  for (const path of paths) {
    const module = matchPendingModulesByPath(path);
    if (module?.name && !seen.has(module.name)) {
      seen.add(module.name);
      modules.push(module);
    }
  }
  return modules.slice(0, topK);
};

// 返回首个命中的 { module, strength } | null。
// 注意：仅在需要"任意一个命中模块"语义时使用；recallByPaths 使用 findAllModuleMatches 取全集。
export const matchModuleByPath = (filePath) => {
  for (const module of listModulesWithMeta()) {
    for (const entry of module.paths) {
      if (matchPathPattern(filePath, entry.path)) {
        return { module, strength: entry.strength };
      }
    }
  }
  return null;
};
