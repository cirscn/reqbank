// P5 L2 语法感知层：tree-sitter WASM 懒加载器 + 结构提取。
// 设计约束（docs/roadmap.md P5）：
//   - 零 npm 运行时依赖：vendor/ 静态资产（web-tree-sitter 0.22.6 + brotli 压缩语法包）
//   - 按文件后缀懒加载语法包：用不到的语言不进内存（模块级缓存，进程即弃）
//   - 字符串预筛命中才解析（assertions.mjs 负责）：无断言的回合零 WASM 成本
//   - 片段用完即弃：不建索引、不落盘——真源是唯一事实，AST 只是当次判定的透镜
//   - 全平台：Node 22 内置 WASM 引擎，Windows/Linux/macOS/ARM 同一份 .wasm

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'tree-sitter');
const require = createRequire(import.meta.url);

// ── 项目级语言扩展（reqbank lang add 落盘到真源旁，随仓库共享）──
const projectHarnessRoot = () => {
  if (process.env.HARNESS_PROJECT_ROOT) {
    return join(process.env.HARNESS_PROJECT_ROOT, '.agentdoc', 'harness');
  }
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, '.agentdoc', 'harness');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

let projectLangMapCache = null;
const projectLangMap = () => {
  if (projectLangMapCache !== null) {
    return projectLangMapCache;
  }
  projectLangMapCache = new Map();
  try {
    const root = projectHarnessRoot();
    const mapPath = root ? join(root, 'vendor-lang', 'lang-map.json') : null;
    if (mapPath && existsSync(mapPath)) {
      const parsed = JSON.parse(readFileSync(mapPath, 'utf8'));
      for (const [ext, name] of Object.entries(parsed)) {
        if (typeof ext === 'string' && typeof name === 'string' && ext.startsWith('.')) {
          projectLangMapCache.set(ext, name);
        }
      }
    }
  } catch {
    // lang-map 损坏：仅禁用项目扩展，不影响内置语言
  }
  return projectLangMapCache;
};

export const resetProjectLangMapCache = () => {
  projectLangMapCache = null;
};

// 后缀 → 语法包名。JSX 归 javascript 语法包；TSX 单独包。
const EXTENSION_LANGUAGES = new Map([
  ['.js', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'], ['.jsx', 'javascript'],
  ['.ts', 'typescript'], ['.mts', 'typescript'], ['.cts', 'typescript'],
  ['.tsx', 'tsx'],
  ['.java', 'java'],
  ['.py', 'python'],
  ['.go', 'go'],
  ['.rs', 'rust']
]);

// 声明式配置明确不做 AST（P5 定稿）：YAML/JSON/HTML/CSS 留在字符串断言层。
export const astLanguageForPath = (filePath) => {
  const dot = String(filePath ?? '').lastIndexOf('.');
  if (dot < 0) return null;
  const ext = String(filePath).slice(dot);
  return projectLangMap().get(ext) ?? EXTENSION_LANGUAGES.get(ext) ?? null;
};

export const astSupportedLanguages = () => [
  ...new Set([...EXTENSION_LANGUAGES.values(), ...projectLangMap().values()])
];

export const builtinAstLanguages = () => [...new Set([...EXTENSION_LANGUAGES.values()])];

// ── 懒加载状态（模块级；测试用 resetAstState/getLoadedGrammarNames 探针）──
let initPromise = null;
const languageCache = new Map(); // 语言名 → Language（getLoadedGrammarNames 暴露已加载集）

const ensureParser = async () => {
  if (!initPromise) {
    initPromise = (async () => {
      const entry = join(VENDOR_DIR, 'tree-sitter.cjs');
      if (!existsSync(entry)) {
        throw new Error(`tree-sitter runtime missing: ${entry}`);
      }
      // CJS 胶水经 createRequire 加载：Emscripten 以 __dirname 定位同级 tree-sitter.wasm
      const Parser = require(entry);
      await Parser.init();
      return Parser;
    })().catch((error) => {
      initPromise = null; // 失败不缓存——vendor 损坏时每次都报，而不是静默禁用
      throw error;
    });
  }
  return initPromise;
};

const grammarCandidates = (name) => {
  const fileName = `tree-sitter-${name}.wasm.br`;
  const roots = [projectHarnessRoot() ? join(projectHarnessRoot(), 'vendor-lang') : null, join(VENDOR_DIR, 'grammars')];
  return roots.filter(Boolean).map((dir) => join(dir, fileName));
};

const loadLanguage = async (name) => {
  if (languageCache.has(name)) {
    return languageCache.get(name);
  }
  const Parser = await ensureParser();
  const grammarPath = grammarCandidates(name).find((path) => existsSync(path));
  if (!grammarPath) {
    throw new Error(`grammar missing: tree-sitter-${name}.wasm.br（内置目录与项目 vendor-lang/ 均未找到）`);
  }
  const lang = await Parser.Language.load(brotliDecompressSync(readFileSync(grammarPath)));
  languageCache.set(name, lang);
  return lang;
};

// ── 结构提取：按语言族的节点/字段名（eval/p5-ast.mjs 各语言用例锁定）──
const CALL_NODE_TYPES = {
  javascript: ['call_expression'], typescript: ['call_expression'], tsx: ['call_expression'],
  java: ['method_invocation'], python: ['call'], go: ['call_expression'], rust: ['call_expression']
};
const CALL_FIELD_BY_TYPE = { call_expression: 'function', method_invocation: 'name', call: 'function' };
// lang add 扩展语言的通用兜底：多数 BNF 风格语法包沿用这些节点/字段惯例（best-effort）
const GENERIC_CALL_TYPE = /^(call_expression|call|method_invocation|function_invocation|invoke_expression)$/;
const GENERIC_CALL_FIELDS = ['function', 'name', 'callee', 'function_designator'];

const walk = (node, visit) => {
  visit(node);
  for (let index = 0; index < node.childCount; index += 1) {
    walk(node.child(index), visit);
  }
};

const IDENTIFIER_LIKE = /^[A-Za-z_$][\w$]*$/;
const calleeNameOf = (callNode) => {
  const fieldNames = CALL_FIELD_BY_TYPE[callNode.type] ? [CALL_FIELD_BY_TYPE[callNode.type]] : GENERIC_CALL_FIELDS;
  let fn = null;
  for (const field of fieldNames) {
    fn = callNode.childForFieldName(field);
    if (fn) break;
  }
  if (!fn) {
    // 无字段名惯例的语法包（kotlin call_expression 等）：首个标识符形态子节点视为被调者
    fn = [...Array.from({ length: callNode.childCount }, (_, i) => callNode.child(i))]
      .find((child) => IDENTIFIER_LIKE.test(String(child?.text ?? ''))) ?? null;
  }
  if (!fn) return null;
  // obj.bar() 取末段 bar：断言按函数名匹配（跨对象统一拦截同名调用）
  const tail = String(fn.text ?? '').split('.').pop().trim();
  return tail || null;
};

const isBangNegation = (node, language) =>
  language === 'python' ? node.type === 'not_operator'
    : node.type === 'unary_expression' && node.child(0)?.text === '!';

// lang add 扩展语言兜底：unary/prefix 节点带 ! 操作符即视为取反（kotlin prefix_expression 等）
const isGenericBangNegation = (node) =>
  /^(unary_expression|prefix_expression|unary_exp)/.test(node.type) && node.child(0)?.text === '!';

const negatedIdentifierOf = (node) => {
  // 字段名跨语法族不统一：js/ts/python 用 argument，java/go 用 operand
  const argument = node.childForFieldName('argument')
    ?? node.childForFieldName('operand')
    ?? [...Array.from({ length: node.childCount }, (_, i) => node.child(i))]
      .filter((child) => /identifier|name|member_expression|attribute|selector_expression/.test(child?.type ?? ''))
      .pop();
  if (!argument) return null;
  // !fn(x) 形态：否定的是调用——取被调函数名（no-negate 守卫的主要形态）
  if (CALL_FIELD_BY_TYPE[argument.type]) {
    return calleeNameOf(argument);
  }
  const tail = String(argument.text ?? '').split('.').pop().trim();
  return IDENTIFIER_LIKE.test(tail) ? tail : null;
};

/**
 * 解析代码片段并提取结构事实：{ language, calls[], negations[] }。
 * 返回 null 表示该语言无语法包或解析失败——AST 是增强不是前提，调用方回退字符串层。
 */
export const analyzeFragment = async ({ language, code }) => {
  if (!astSupportedLanguages().includes(language)) {
    return null;
  }
  try {
    const Parser = await ensureParser();
    const lang = await loadLanguage(language);
    const parser = new Parser();
    parser.setLanguage(lang);
    // Go 等语法要求语句以换行收尾：diff 片段统一补尾换行（对其余语言无影响）
    const source = String(code ?? '');
    const tree = parser.parse(source.endsWith('\n') || source === '' ? source : `${source}\n`);
    const calls = [];
    const negations = [];
    let hasError = false;
    const callTypes = CALL_NODE_TYPES[language] ?? [];
    const isKnownFamily = callTypes.length > 0;
    walk(tree.rootNode, (node) => {
      if (node.type === 'ERROR' || node.isMissing) {
        hasError = true;
      }
      const isCall = isKnownFamily
        ? callTypes.includes(node.type)
        : GENERIC_CALL_TYPE.test(node.type);
      if (isCall) {
        const name = calleeNameOf(node);
        if (name) calls.push(name);
      } else if (isBangNegation(node, language) || (!isKnownFamily && isGenericBangNegation(node))) {
        const name = negatedIdentifierOf(node);
        if (name) negations.push(name);
      }
    });
    parser.delete();
    tree.delete();
    return { language, calls, negations, hasError };
  } catch {
    return null; // vendor 缺失/损坏/语法不识别：回退字符串断言层
  }
};

// ── 测试探针（eval/p5-ast.mjs 懒加载验证）──
export const getLoadedGrammarNames = () => [...languageCache.keys()];
export const resetAstState = () => {
  initPromise = null;
  languageCache.clear();
};

/**
 * vendor 完整性校验（reqbank check --vendor）：sha256 对照 VENDOR.json。
 * 返回 [] 表示完好；否则返回问题清单（文件缺失/哈希不符/VENDOR.json 无法解析）。
 */
export const verifyVendorAssets = () => {
  const problems = [];
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(join(VENDOR_DIR, 'VENDOR.json'), 'utf8'));
  } catch (error) {
    return [`VENDOR.json 无法读取/解析：${error.message}`];
  }
  const sha256Of = (relative) => {
    const path = join(VENDOR_DIR, relative);
    if (!existsSync(path)) return null;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  };
  for (const [file, expected] of Object.entries(manifest.runtime?.files ?? {})) {
    const actual = sha256Of(file);
    if (actual !== expected) {
      problems.push(actual === null ? `缺失 ${file}` : `哈希不符 ${file}（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
    }
  }
  for (const [language, expected] of Object.entries(manifest.grammars?.languages ?? {})) {
    const file = join('grammars', `tree-sitter-${language}.wasm.br`);
    const actual = sha256Of(file);
    if (actual !== expected) {
      problems.push(actual === null ? `缺失 ${file}` : `哈希不符 ${file}`);
    }
  }
  return problems;
};
