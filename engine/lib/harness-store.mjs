// Parse .agentdoc/harness/ structure into recall-able records.
// Recall hook uses this to grep REQ/TC by task keywords; finalize hook uses
// this to verify diff coverage of recalled rules.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getProjectRoot, repoPath } from './repo-paths.mjs';

// 惰性求根：本模块被 lint.mjs 等库文件 import，非 harness 项目内 import 不得崩溃——
// 根路径延迟到首次实际取用（取用时无根自然报错，import 本身零副作用）。
let harnessRootCache = null;
const harnessRoot = () => {
  if (harnessRootCache === null) {
    harnessRootCache = repoPath('.agentdoc', 'harness');
  }
  return harnessRootCache;
};

const readText = (path) => readFileSync(path, 'utf8');

// 模板在各清单节内留有 <!-- 格式：… --> 格式提示注释；解析器一律跳过，不得当作登记项。
const isCommentLine = (line) => line.trim().startsWith('<!--');

// P4 检索缓存：mtime 未变的文件复用上一次解析文本。修复「一次 PostToolUse = 两层全库扫描」
//（recallByPaths → findAllModuleMatches 每文件重复 listModulesWithMeta → 全部 index.md 重解析）。
// 进程内生效（每个钩子是新进程），无需失效协议——真源每回合最多改一次，mtime 是充分信号。
const textCache = new Map();
export const readTextCached = (path) => {
  const stat = statSync(path);
  const cached = textCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.text;
  }
  const text = readText(path);
  textCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, text });
  return text;
};

// 解析期警告/错误收集：钩子路径静默忽略（不打扰会话），`reqbank check` 消费后呈现。
// kind: 'error' 使 check 失败；'warning' 仅提示（如未识别段名——可能是文档漂移）。
const parseWarnings = [];
export const consumeParseWarnings = () => {
  const warnings = [...parseWarnings];
  parseWarnings.length = 0;
  return warnings;
};

const REQ_SECTIONS = new Set(['索引', '需求澄清', '注意事项', '断言']);
const TEST_SECTIONS = new Set(['索引', '内容索引', '测试用例']);

// P2 条款断言层：把「不得做什么」从自然语言编译成闭集可执行检查。
// kinds：no-delete（删除行含 pattern → conflict，catch 守卫被删）/ forbid-add（新增行含 pattern → conflict，
// 确定性捕获「新增式违反」——此前只有开 LLM critic 才能抓）/ forbid-path（改动路径命中 glob → conflict）。
// P5 L2 结构化断言：forbid-call（AST 确认的调用点，注释/字符串提及不误报）/
// no-negate（守卫标识符被取反 !x / not x）——经 engine/lib/ast.mjs 语法包懒加载，无语法包语言退回字符串层。
export const ASSERTION_KINDS = new Set(['no-delete', 'forbid-add', 'forbid-path', 'forbid-call', 'no-negate']);
const ASSERTION_LINE = /^(G?REQ-\d{3,})\s\|\s(no-delete|forbid-add|forbid-path|forbid-call|no-negate)\s\|\s(.+)$/;

// P3 生命周期 + 置信度：索引行可选第 5 列（缺省 active:confirmed，旧 4 列格式零迁移）：
//   REQ-001 | tags | TC-001 | active:confirmed | 标题
//   状态：active | draft | superseded>REQ-009（非 active 不参与召回/执法/验证）
//   置信度：confirmed | inferred（推断，待人审）| gap（代码无法判定，强制人工确认）
//   执法档：warn（conflict 降级 warning，不硬拦）| 缺省 block
export const INDEX_META_PATTERN = /^(active|draft|superseded>(G?REQ-\d{3,}))(?::(confirmed|inferred|gap))?(?::(warn))?$/;

export const parseIndexMeta = (meta) => {
  if (!meta) {
    return { status: 'active', supersedes: null, confidence: 'confirmed', enforcement: 'block' };
  }
  const match = INDEX_META_PATTERN.exec(meta);
  if (!match) {
    return null;
  }
  return {
    status: match[1].startsWith('superseded>') ? 'superseded' : match[1],
    supersedes: match[1].startsWith('superseded>') ? match[1].slice('superseded>'.length) : null,
    confidence: match[3] ?? 'confirmed',
    enforcement: match[4] ?? 'block'
  };
};

const parseRequirements = (file, scope) => {
  if (!existsSync(file)) {
    return [];
  }
  const records = [];
  let currentSection = '';
  const indexMap = new Map();
  const clarifications = new Map();
  const assertionsByReq = new Map();

  for (const line of readTextCached(file).split('\n')) {
    if (line.startsWith('## ')) {
      currentSection = line.replace(/^##\s+/, '').trim();
      if (currentSection && !REQ_SECTIONS.has(currentSection)) {
        parseWarnings.push({ kind: 'warning', code: 'unknown-section', message: `${file} 出现未识别段名「## ${currentSection}」（已知：${[...REQ_SECTIONS].join('、')}）——该段下条目不会被解析` });
      }
      continue;
    }
    if (currentSection === '索引') {
      // 中列（关联 TC）允许留空：空列不等于格式错误，解析为 relatedTests=[]，
      // 由 trace-integrity lint 的「未挂任何 TC」警告接住——而不是整行静默丢弃。
      // 可选第 5 列为生命周期元数据（active:confirmed 等），解析失败回落 4 列旧格式。
      const match = line.match(/^(G?REQ-\d{3,})\s\|\s([^|]+)\s\|\s([^|]*)\s*\|\s(.+)/);
      if (match) {
        if (indexMap.has(match[1])) {
          parseWarnings.push({ kind: 'error', code: 'duplicate-id', message: `${scope}:${match[1]} 索引行重复定义（后写覆盖先写，先写条目丢失）——${file}` });
        }
        const titleParts = match[4].split('|').map((part) => part.trim());
        let meta = null;
        let title = match[4].trim();
        if (titleParts.length >= 2) {
          const candidate = parseIndexMeta(titleParts[0]);
          if (candidate) {
            meta = candidate;
            title = titleParts.slice(1).join(' | ').trim();
          }
        }
        indexMap.set(match[1], {
          id: match[1],
          tags: match[2].split(',').map((tag) => tag.trim()).filter(Boolean),
          relatedTests: match[3].split(',').map((id) => id.trim()).filter(Boolean),
          title,
          ...(meta ?? parseIndexMeta(null))
        });
      }
    }
    if (currentSection === '需求澄清') {
      const match = line.match(/^(G?REQ-\d{3,}):\s+(.+)/);
      if (match) {
        clarifications.set(match[1], match[2].trim());
      }
    }
    if (currentSection === '断言') {
      const match = line.match(ASSERTION_LINE);
      if (match && ASSERTION_KINDS.has(match[2])) {
        if (!assertionsByReq.has(match[1])) {
          assertionsByReq.set(match[1], []);
        }
        assertionsByReq.get(match[1]).push({ kind: match[2], pattern: match[3].trim() });
      } else if (line.trim() && !line.startsWith('#') && !isCommentLine(line)) {
        parseWarnings.push({ kind: 'warning', code: 'assertion-format', message: `${file} 断言行格式无法识别（应为 REQ-id | no-delete|forbid-add|forbid-path|forbid-call|no-negate | pattern）：${line.trim().slice(0, 60)}` });
      }
    }
  }

  for (const [id, entry] of indexMap) {
    records.push({
      ...entry,
      scope,
      file,
      clarification: clarifications.get(id) ?? '',
      assertions: assertionsByReq.get(id) ?? []
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

  for (const line of readTextCached(file).split('\n')) {
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
      const match = line.match(/^(G?TC-\d{3,})\s\|\s([^|]+)\s\|\s([^|]*)\s*\|\s(.+)/);
      if (match) {
        if (indexMap.has(match[1])) {
          parseWarnings.push({ kind: 'error', code: 'duplicate-id', message: `${scope}:${match[1]} 内容索引行重复定义（后写覆盖先写，先写条目丢失）——${file}` });
        }
        indexMap.set(match[1], {
          id: match[1],
          tags: match[2].split(',').map((tag) => tag.trim()).filter(Boolean),
          relatedReqs: match[3].split(',').map((id) => id.trim()).filter(Boolean),
          title: match[4].trim(),
          // TC 不单独携带生命周期（跟随 REQ 第 5 列），但 active 过滤需要字段存在
          ...(parseIndexMeta(null))
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
  const modulesRoot = join(harnessRoot(), 'modules');
  if (!existsSync(modulesRoot)) {
    return [];
  }
  return readdirSync(modulesRoot)
    .map((entry) => join(modulesRoot, entry))
    .filter((path) => statSync(path).isDirectory())
    .filter((path) => basename(path.replace(/\\/g, '/')) !== '_template');
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
  for (const line of readTextCached(indexPath).split('\n')) {
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
  const indexPath = join(harnessRoot(), 'global', 'index.md');
  if (!existsSync(indexPath)) {
    return [];
  }
  const entries = [];
  let inSection = false;
  for (const line of readTextCached(indexPath).split('\n')) {
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

// includeInactive=false（默认）：draft/superseded 条目不进入召回与执法（运行时语义）；
// `reqbank check` 传 true 做全量追溯校验（superseded 目标存在性、取代链查环）。
export const loadAllRequirements = ({ includeInactive = false } = {}) => {
  const records = parseRequirements(join(harnessRoot(), 'global', 'requirements.md'), 'global');
  for (const moduleDir of listModuleDirs()) {
    const name = moduleDir.split('/').pop();
    records.push(...parseRequirements(join(moduleDir, 'requirements.md'), name));
  }
  return includeInactive ? records : records.filter((record) => record.status === 'active');
};

// P5 验收发现的执法漏洞修复：断言是闭集确定性规则（字符串预筛，每条成本极低），
// 不应被路径召回预算门控——forbid-call 挂在 request 模块条款上时，hooks 模块文件的
// 违规调用此前因召回不到而完全绕过。断言层全库扫描，n-gram 分类维持召回域不变。
export const loadAssertionBearers = () =>
  loadAllRequirements().filter((record) => (record.assertions ?? []).length > 0);

export const loadAllTests = ({ includeInactive = false } = {}) => {
  const records = parseTests(join(harnessRoot(), 'global', 'tests.md'), 'global');
  for (const moduleDir of listModuleDirs()) {
    const name = moduleDir.split('/').pop();
    records.push(...parseTests(join(moduleDir, 'tests.md'), name));
  }
  return includeInactive ? records : records.filter((record) => record.status === 'active');
};

export const listModulesWithMeta = () => {
  return [{
    name: 'global',
    dir: join(harnessRoot(), 'global'),
    paths: getGlobalHitPaths()
  }, ...listModuleDirs().map((dir) => ({
    name: dir.split('/').pop(),
    dir,
    paths: getModuleHitPaths(dir)
  }))];
};

export const listPendingModules = () => {
  const indexPath = join(harnessRoot(), 'index.md');
  if (!existsSync(indexPath)) {
    return [];
  }
  const pendings = [];
  let inSection = false;
  for (const line of readTextCached(indexPath).split('\n')) {
    if (line.startsWith('## ')) {
      inSection = line.replace(/^##\s+/, '').trim() === '待初始化高风险模块';
      continue;
    }
    if (inSection && line.includes('|') && !isCommentLine(line)) {
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

// 根 index.md「已建模块」清单解析：与 modules/ 目录实况对照，漂移由 trace-integrity lint 报告。
export const listRegisteredModules = () => {
  const indexPath = join(harnessRoot(), 'index.md');
  if (!existsSync(indexPath)) {
    return [];
  }
  const names = [];
  let inSection = false;
  for (const line of readTextCached(indexPath).split('\n')) {
    if (line.startsWith('## ')) {
      inSection = line.replace(/^##\s+/, '').trim() === '已建模块';
      continue;
    }
    if (inSection && line.includes('|') && !isCommentLine(line)) {
      const name = line.split('|').map((part) => part.trim())[0].replace(/^- /, '');
      if (name && !name.startsWith('#')) {
        names.push(name);
      }
    }
  }
  return names;
};

// ── 召回配置（真源数据化）──────────────────────────────────────────────
// 根 index.md 可选「## 召回配置」节，两类行：
//   - 通用标签: pcr,io,i18n,...        （不参与 tag-coverage 强校验 / 路径标签特异性判定）
//   - 同义词组: ratio,占比,百分比      （组内任一命中即互相扩展）
// 缺省回落到引擎内置默认——存量仓库零迁移成本。
const DEFAULT_GENERIC_RECALL_TAGS = [
  'pcr', 'io', 'i18n', 'request', 'validation', 'save-payload', 'api-contract', 'ui-interaction'
];
const DEFAULT_SYNONYM_GROUPS = [
  ['ratio', '占比', '百分比'],
  ['contribution', '贡献', '贡献度'],
  ['cut', 'off', 'cut-off', 'cutoff']
];

let recallConfigCache = null;
const loadRecallConfig = () => {
  if (recallConfigCache) {
    return recallConfigCache;
  }
  const generic = new Set(DEFAULT_GENERIC_RECALL_TAGS);
  const synonymGroups = DEFAULT_SYNONYM_GROUPS.map((group) => [...group]);
  // 无项目根（本模块被 lint.mjs 等库文件在非 harness 上下文 import）时回落内置默认——import 零副作用
  let indexPath = '';
  try {
    indexPath = join(harnessRoot(), 'index.md');
  } catch {
    indexPath = '';
  }
  if (indexPath && existsSync(indexPath)) {
    let inSection = false;
    for (const line of readTextCached(indexPath).split('\n')) {
      if (line.startsWith('## ')) {
        inSection = line.replace(/^##\s+/, '').trim() === '召回配置';
        continue;
      }
      if (!inSection || !line.includes(':')) {
        continue;
      }
      const [key, rawValue] = line.replace(/^-\s*/, '').split(':');
      const values = (rawValue ?? '').split(',').map((v) => v.trim()).filter(Boolean);
      if (!values.length) {
        continue;
      }
      if (key.trim() === '通用标签') {
        generic.clear();
        for (const tag of values) generic.add(tag);
      } else if (key.trim() === '同义词组') {
        synonymGroups.push(values);
      }
    }
  }
  recallConfigCache = { generic, synonymGroups };
  return recallConfigCache;
};

export const getGenericRecallTags = () => loadRecallConfig().generic;

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
  const { synonymGroups } = loadRecallConfig();
  for (const group of synonymGroups) {
    if (group.some((term) => expanded.has(term))) {
      for (const term of group) {
        expanded.add(term);
      }
    }
  }
  return [...expanded];
};

const scopedRecordId = (record) => `${record.scope}:${record.id}`;

const GENERIC_RECALL_TAGS_LEGACY = new Set(DEFAULT_GENERIC_RECALL_TAGS);
void GENERIC_RECALL_TAGS_LEGACY;

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

export const matchPathPattern = (filePath, pattern) => {
  if (pattern.endsWith('/') && filePath.startsWith(pattern)) {
    return true;
  }
  if (pattern.includes('**')) {
    // ** 跨目录通配（P3）：段内仍有 * 时按单段处理——src/**/*.test.ts
    const regex = new RegExp(`^${pattern
      .split('**')
      .map((segment) => segment.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+'))
      .join('.*')}$`);
    return regex.test(filePath);
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
// options.recordKind: 'req-only' 时只召回 REQ（critic 通道——TC 的 V 命令富含守卫词，
//   会把真正被违反的 REQ 挤出 topK；TC 改为判冲突后按需补充）；
// options.moduleQuota: 每模块最多入选条数（global 同额但保底一席逻辑不变）——
//   双模块任务不再被单一模块整段占满 topK。
export const recallByPaths = (paths, { topK = 3, keywords = [], recordKind = 'all', moduleQuota = null } = {}) => {
  const genericTags = getGenericRecallTags();
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

  const all = recordKind === 'req-only' ? loadAllRequirements() : [...loadAllRequirements(), ...loadAllTests()];
  const scored = all
    .filter((record) => validModules.has(record.scope))
    .map((record, index) => {
      const pathTags = modulePathTags.get(record.scope) ?? new Set();
      const matchedTagCount = (record.tags ?? []).filter((tag) => pathTags.has(tag)).length;
      const specificMatchedTagCount = (record.tags ?? []).filter((tag) =>
        pathTags.has(tag) && !genericTags.has(tag)
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
    const hasSpecificPathTags = [...pathTags].some((tag) => !genericTags.has(tag));
    return !pathTags.size || entry.specificMatchedTagCount > 0 || (!hasSpecificPathTags && entry.matchedTagCount > 0);
  });
  const tagMatched = scored.filter((entry) => {
    const pathTags = modulePathTags.get(entry.record.scope) ?? new Set();
    const requiredTagCount = entry.record.scope === 'global' && pathTags.size >= 2 ? 2 : 1;
    const hasSpecificPathTags = [...pathTags].some((tag) => !genericTags.has(tag));
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
  const quotaApplied = moduleQuota
    ? (() => {
        const counts = new Map();
        return sortedEntries.filter((entry) => {
          const scope = entry.record.scope;
          const count = counts.get(scope) ?? 0;
          if (count >= moduleQuota) {
            return false;
          }
          counts.set(scope, count + 1);
          return true;
        });
      })()
    : sortedEntries;
  const picked = quotaApplied.slice(0, topK).map((entry) => entry.record);
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
