// P2 条款断言层：确定性闭集规则匹配，在 n-gram 分类器之前运行。
// 每次命中可归因到「哪条断言、哪一行」——warrant-mcp「决策归因到条款」哲学的零依赖版。
// 断言来源：requirements.md「## 断言」节（harness-store 解析为 record.assertions）。
//
// P5 L2 结构化断言：forbid-call / no-negate 走「字符串预筛 → AST 确认」两级：
//   - 预筛不命中 → 零解析成本（无断言回合不碰 WASM）
//   - 预筛命中且语言有语法包 → 解析新增片段：AST 找到调用/取反才命中，
//     注释与字符串字面量里的提及被推翻（forbid-call 不误报的核心价值）
//   - 解析带 ERROR（diff 片段不完整）或无语法包/vendor 缺失 → 保留字符串命中
//     （AST 是增强不是前提：宁可可抑制的误拦，不可静默放行）

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const containsPattern = (line, pattern) => {
  if (/[\u4e00-\u9fff]/.test(pattern)) {
    // CJK 模式：子串匹配
    return line.includes(pattern);
  }
  // 拉丁模式：整词边界，避免 message 误命中 message.error 之外的子串
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(pattern)}(?![A-Za-z0-9_])`).test(line);
};

const splitRawLines = (diff) => {
  const added = [];
  const removed = [];
  for (const line of String(diff ?? '').split(/\r?\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added.push(line.slice(1));
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      removed.push(line.slice(1));
    }
  }
  return { added, removed };
};

// no-negate 字符串预筛（无语法包语言的兜底命中层）：
// `!name`（排除 != / !==）/ Python `not name`
const negationPrefilter = (line, pattern) =>
  new RegExp(`!(?!=)\\s*${escapeRegExp(pattern)}(?![A-Za-z0-9_])`).test(line)
  || new RegExp(`(^|[^A-Za-z0-9_])not\\s+${escapeRegExp(pattern)}(?![A-Za-z0-9_])`).test(line);

const STRUCTURAL_KINDS = new Set(['forbid-call', 'no-negate']);

/**
 * 断言池合并：召回集 ∪ 全库断言承载条款（按 scope:id 去重，召回集优先）。
 * 断言层全库扫描（闭集规则，预筛极廉价）；n-gram 分类仍只用召回集。
 */
export const mergeAssertionPool = (recalledReqs, bearers = []) => {
  const seen = new Set((recalledReqs ?? []).map((record) => `${record.scope}:${record.id}`));
  const pool = [...(recalledReqs ?? [])];
  for (const record of bearers ?? []) {
    const key = `${record.scope}:${record.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      pool.push(record);
    }
  }
  return pool;
};

/**
 * 对召回的 REQ 逐条跑断言匹配。
 * 返回 [{ record, kind, pattern, matchedLine, file }]——命中即确定性 conflict（零 LLM、零 API）。
 * P5 起为 async：结构化断言需异步加载语法包（懒加载，仅预筛命中才发生）。
 */
export const runAssertionReview = async ({ diff, filePaths = [], recalledReqs = [], matchPathPattern }) => {
  if (!matchPathPattern) {
    return [];
  }
  const { added, removed } = splitRawLines(diff);
  const hits = [];
  // 预筛命中、待 AST 确认的结构化候选：[{ record, assertion, line }]
  const structuralCandidates = [];
  let structuralLanguage = null;
  for (const record of recalledReqs) {
    for (const assertion of record.assertions ?? []) {
      if (assertion.kind === 'forbid-path') {
        for (const filePath of filePaths) {
          if (matchPathPattern(filePath, assertion.pattern)) {
            hits.push({ record, kind: assertion.kind, pattern: assertion.pattern, matchedLine: filePath, file: filePath });
          }
        }
        continue;
      }
      if (STRUCTURAL_KINDS.has(assertion.kind)) {
        const matcher = assertion.kind === 'no-negate'
          ? (line) => negationPrefilter(line, assertion.pattern)
          : (line) => containsPattern(line, assertion.pattern);
        for (const line of added) {
          if (matcher(line)) {
            structuralCandidates.push({ record, assertion, line });
            break; // 每条断言记一次即可
          }
        }
        continue;
      }
      const lines = assertion.kind === 'no-delete' ? removed : added;
      for (const line of lines) {
        if (containsPattern(line, assertion.pattern)) {
          hits.push({ record, kind: assertion.kind, pattern: assertion.pattern, matchedLine: line.trim().slice(0, 160), file: filePaths[0] ?? '' });
          break; // 每条断言记一次即可
        }
      }
    }
  }
  if (!structuralCandidates.length) {
    return hits;
  }

  // 结构化确认：按主文件后缀选语法包（critic 的 diff 单文件为主；gate/finalize 逐文件调用）
  const { astLanguageForPath, analyzeFragment } = await import('./ast.mjs');
  structuralLanguage = astLanguageForPath(filePaths[0] ?? '');
  const fragment = added.join('\n');
  let analysis = null;
  if (structuralLanguage) {
    analysis = await analyzeFragment({ language: structuralLanguage, code: fragment });
  }
  for (const { record, assertion, line } of structuralCandidates) {
    let hit = true; // 无语法包 / vendor 缺失 → 字符串命中保留
    if (analysis && !analysis.hasError) {
      // 干净解析才允许推翻：AST 里没有真实调用/取反，说明命中的是注释或字符串提及。
      // 成员式 pattern（message.error）与提取的尾段名（error）需两侧对齐：
      //   调用侧取尾段比对 pattern 尾段；pattern 全文命中调用全文（calls 存尾段，通常走前者）
      if (assertion.kind === 'forbid-call') {
        const patternTail = assertion.pattern.includes('.') ? assertion.pattern.split('.').pop() : assertion.pattern;
        hit = analysis.calls.includes(assertion.pattern) || analysis.calls.includes(patternTail);
      } else {
        hit = analysis.negations.includes(assertion.pattern);
      }
    }
    if (hit) {
      hits.push({
        record,
        kind: assertion.kind,
        pattern: assertion.pattern,
        matchedLine: line.trim().slice(0, 160),
        file: filePaths[0] ?? '',
        confirmedByAst: Boolean(analysis && !analysis.hasError)
      });
    }
  }
  return hits;
};

export const ASSERTION_FEEDBACK = {
  'no-delete': '该 token 是条款守卫，删除属于确定性违反——恢复守卫或在澄清里显式退役该条款',
  'forbid-add': '新增内容命中禁止项——改用条款允许的替代写法',
  'forbid-path': '该路径受条款保护，禁止改动——如确需修改，先更新契约再动手',
  'forbid-call': 'AST 确认的真实调用点（注释/字符串提及不算）——改用条款允许的替代调用',
  'no-negate': '守卫标识符被取反（!x / not x）——极性翻转会让守卫反向放行，恢复原极性'
};
