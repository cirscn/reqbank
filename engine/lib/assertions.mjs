// P2 条款断言层：确定性闭集规则匹配，在 n-gram 分类器之前运行。
// 每次命中可归因到「哪条断言、哪一行」——warrant-mcp「决策归因到条款」哲学的零依赖版。
// 断言来源：requirements.md「## 断言」节（harness-store 解析为 record.assertions）。

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

/**
 * 对召回的 REQ 逐条跑断言匹配。
 * 返回 [{ record, kind, pattern, matchedLine, file }]——命中即确定性 conflict（零 LLM、零 API）。
 */
export const runAssertionReview = ({ diff, filePaths = [], recalledReqs = [], matchPathPattern }) => {
  if (!matchPathPattern) {
    return [];
  }
  const { added, removed } = splitRawLines(diff);
  const hits = [];
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
      const lines = assertion.kind === 'no-delete' ? removed : added;
      for (const line of lines) {
        if (containsPattern(line, assertion.pattern)) {
          hits.push({ record, kind: assertion.kind, pattern: assertion.pattern, matchedLine: line.trim().slice(0, 160), file: filePaths[0] ?? '' });
          break; // 每条断言记一次即可
        }
      }
    }
  }
  return hits;
};

export const ASSERTION_FEEDBACK = {
  'no-delete': '该 token 是条款守卫，删除属于确定性违反——恢复守卫或在澄清里显式退役该条款',
  'forbid-add': '新增内容命中禁止项——改用条款允许的替代写法',
  'forbid-path': '该路径受条款保护，禁止改动——如确需修改，先更新契约再动手'
};
