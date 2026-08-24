// Templates and helpers for deterministic harness critic signals.
// The critic classifies recalled records as covered / weak / conflict without
// injecting full REQ/TC bodies. A later LLM critic can replace runCriticReview
// without changing hook callsites or log field names.

const formatRecord = (record) => {
  const tags = record.tags?.length ? ` [${record.tags.join(', ')}]` : '';
  return `${record.scope}:${record.id}${tags} - ${record.title || 'untitled'} (${record.file})`;
};

// P1 注入预算协议：对齐 Claude Code hook 输出上限的公开常量（测试可断言）。
export const RECALL_OUTPUT_CAP = 10000;

// P1 分层注入 + 预算协议：
//   L0 禁止类正文直注（obsidian-mind 实证：正向「去查文档」指示常被忽略，禁止类指令才可靠传播）；
//   L1 ID-first 索引（维持轻量）；首行自定位 header——被截断也指明去哪取全文；
//   超预算按整条省略（半条正文读起来像完整条款，比整条省略更危险），L0 最后才让步；
//   末行 meter 报告真实注入量与被省略条目——静默丢失比膨胀更糟。
export const formatRecallContext = (records, { cap = RECALL_OUTPUT_CAP, prohibitLimit = 3 } = {}) => {
  if (!records.length) {
    return '';
  }
  const header = '<!-- reqbank recall: 条款注入；若下方不完整，先运行 reqbank scope "<任务>" 获取全文 -->';
  const prohibitions = [];
  const others = [];
  for (const record of records) {
    if (prohibitions.length < prohibitLimit && hasNegationSignal(recordText(record))) {
      prohibitions.push(record);
    } else {
      others.push(record);
    }
  }
  const entries = [
    ...prohibitions.map((record) => ({
      kind: 'l0',
      id: `${record.scope}:${record.id}`,
      line: `- ${record.scope}:${record.id}: ${record.clarification || record.title || ''}`
    })),
    ...others.map((record) => ({
      kind: 'l1',
      id: `${record.scope}:${record.id}`,
      line: `- ${formatRecord(record)}`
    }))
  ];
  const build = (list) => {
    const lines = [header];
    const l0 = list.filter((entry) => entry.kind === 'l0');
    const l1 = list.filter((entry) => entry.kind === 'l1');
    if (l0.length) {
      lines.push('', '禁止类条款（正文直注，最高优先遵守）：', ...l0.map((entry) => entry.line));
    }
    if (l1.length) {
      lines.push('', '其余命中条款（ID 索引，动手前先读 clarification）：', ...l1.map((entry) => entry.line));
    }
    return lines.join('\n');
  };
  const meterReserve = 200;
  const kept = [...entries];
  const droppedIds = [];
  const overBudget = (list) => build(list).length + meterReserve > cap;
  while (overBudget(kept) && kept.length) {
    // 先整条丢 L1 尾部；L0（禁止类正文）受保护，最后才让步
    let victimIndex = -1;
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      if (kept[index].kind === 'l1') {
        victimIndex = index;
        break;
      }
    }
    if (victimIndex < 0) {
      for (let index = kept.length - 1; index >= 0; index -= 1) {
        if (kept[index].kind === 'l0') {
          victimIndex = index;
          break;
        }
      }
    }
    if (victimIndex < 0) {
      break;
    }
    droppedIds.unshift(kept[victimIndex].id);
    kept.splice(victimIndex, 1);
  }
  const body = build(kept);
  const droppedText = droppedIds.length
    ? `，整条省略：${droppedIds.slice(0, 10).join(', ')}${droppedIds.length > 10 ? ` 等 ${droppedIds.length} 条` : ''}`
    : '';
  const meter = `<!-- reqbank recall meter: 注入 ${kept.length}/${records.length} 条，${body.length} chars，预算 ${cap}${droppedText} -->`;
  return `${body}\n${meter}`;
};

export const formatCriticVerdict = (verdict) => {
  const lines = ['Harness critic:'];
  lines.push(`- semantic: ${verdict.severity}`);
  if (verdict.covered?.length) {
    lines.push(`- covered: ${verdict.covered.map((rec) => `${rec.scope}:${rec.id}`).join(', ')}`);
  }
  if (verdict.weak?.length) {
    lines.push(
      `- weak: ${verdict.weak.map((rec) => `${rec.scope}:${rec.id}`).join(', ')}`
    );
  }
  if (verdict.conflicts?.length) {
    lines.push(`- conflict: ${verdict.conflicts.map((rec) => `${rec.scope}:${rec.id}`).join(', ')}`);
  }
  if (verdict.notes) {
    lines.push(`- note: ${verdict.notes}`);
  }
  return lines.join('\n');
};

const normalizeText = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const splitTokens = (value) => normalizeText(value)
  .split(' ')
  .filter((token) => token.length >= 2);

const recordText = (record) => [
  record.title,
  record.clarification,
  record.tags?.join(' '),
  record.trigger,
  record.mustVerify,
  record.given?.join(' '),
  record.when?.join(' '),
  record.expect?.join(' '),
  record.verify?.join(' ')
].filter(Boolean).join(' ');

const CJK_EDGE_STOPWORDS = ['的', '了', '是', '在', '和', '或', '与', '把', '从', '给', '到', '为', '以', '及'];

/**
 * 中文契约没有空格边界：整句会归一成单个超长 token，导致命中计数永远不足。
 * 这里按 2~4 字滑窗生成 CJK 信号片段（修剪停用边），与英文单词共同构成证据集。
 */
export const extractCjkSignalGrams = (text) => {
  const grams = new Set();
  for (const match of String(text ?? '').matchAll(/[一-鿿]{2,}/g)) {
    let core = match[0];
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
    if (core.length < 2) continue;
    grams.add(core);
    const windowMax = Math.min(4, core.length);
    for (let size = 2; size <= windowMax; size += 1) {
      for (let start = 0; start + size <= core.length; start += 1) {
        grams.add(core.slice(start, start + size));
      }
    }
  }
  return [...grams];
};

const recordSignals = (record) => {
  const text = recordText(record);
  return Array.from(new Set([...splitTokens(text), ...extractCjkSignalGrams(text)]));
};

const changedLineParts = (diff) => {
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
  return {
    addedText: normalizeText(added.join(' ')),
    removedText: normalizeText(removed.join(' ')),
    fullText: normalizeText(diff)
  };
};

// P5 L1 标点感知：! && || 不再被 normalizeText 丢弃，从原始 diff 行提取布尔三元组。
// 归一化把 `user && active` 与 `!user || active` 压成同一 token 集——极性/连接符翻转是
// n-gram 分类器的结构性盲区（removedHits/addedHits 完全对称），必须看标点才能判定。
const BOOL_TRIPLE = /(!?)[ \t]*([A-Za-z_$][\w$]*)[ \t]*(&&|\|\|)[ \t]*(!?)[ \t]*([A-Za-z_$][\w$]*)/g;

const codeLinesOf = (diff, side) => {
  const lines = [];
  const prefix = side === 'added' ? '+' : '-';
  const other = side === 'added' ? '-' : '+';
  for (let line of String(diff ?? '').split(/\r?\n/)) {
    if (!line.startsWith(prefix) || line.startsWith(`${prefix}${prefix}${prefix}`)) continue;
    if (line.startsWith(other)) continue;
    line = line.slice(1);
    // 纯注释行不参与翻转判定（文档性提及不算语义翻转）
    if (/^\s*(\/\/|\*|#|--)/.test(line)) continue;
    lines.push(line.replace(/\/\/.*$/, '')); // 去行尾注释
  }
  return lines;
};

// 三元组规范化键：操作数名排序 + 按名对齐极性，操作数交换（a&&b ↔ b&&a）不视为翻转。
const tripleKey = (t) => [t.l, t.r].map((name, i) => `${name}:${(i === 0 ? t.lNeg : t.rNeg) ? '!' : ''}`)
  .sort()
  .join(` ${t.op} `);

const triplesOf = (lines) => {
  const map = new Map(); // tripleKey -> 三元组（同名同构只记一次）
  for (const line of lines) {
    for (const match of line.matchAll(BOOL_TRIPLE)) {
      const triple = { l: match[2], lNeg: match[1] === '!', op: match[3], r: match[5], rNeg: match[4] === '!', line: line.trim().slice(0, 160) };
      const key = tripleKey(triple);
      if (!map.has(key)) {
        map.set(key, triple);
      }
    }
  }
  return map;
};

/**
 * 确定性翻转检测：删除侧与新增侧存在同操作数三元组，但连接符（&&↔||）
 * 或任一操作数极性（裸 ↔ !前缀）不同，即为语义翻转。
 * 已知等价改写 `a||b` ↔ `!a&&!b`（De Morgan）也会被判翻转——宁要可抑制的误拦，不要静默放行。
 */
export const detectBooleanFlip = (diff) => {
  const removed = triplesOf(codeLinesOf(diff, 'removed'));
  const added = triplesOf(codeLinesOf(diff, 'added'));
  // 按操作数名集合配对（key 含操作符/极性，翻转双方 key 必不同）
  const namesKey = (t) => [t.l, t.r].sort().join('\u0000');
  const removedByNames = new Map();
  for (const triple of removed.values()) {
    const nk = namesKey(triple);
    if (!removedByNames.has(nk)) removedByNames.set(nk, triple);
  }
  const flips = [];
  for (const triple of added.values()) {
    const counterpart = removedByNames.get(namesKey(triple));
    if (!counterpart) continue;
    const opFlip = counterpart.op !== triple.op;
    const polarityFlip = counterpart.lNeg !== triple.lNeg || counterpart.rNeg !== triple.rNeg;
    if (!opFlip && !polarityFlip) continue;
    flips.push({
      kind: opFlip && polarityFlip ? 'flip:both' : opFlip ? 'flip:operator' : 'flip:polarity',
      removed: counterpart.line,
      added: triple.line
    });
  }
  return flips;
};

const CJK_NEGATION_TOKENS = ['不得', '不能', '禁止', '不允许', '无需', '不再', '一律不', '严禁'];

// 拉丁否定词必须整词匹配：notification 内含子串 not/no，曾把真实违规的拦截静默抑制。
// must 属 RFC2119 义务词而非否定，移出否定表。
const LATIN_NEGATION_PATTERN = /(?:^|[^a-z])(must\s*not|mustnot|forbidden?|disabl(?:e|ed)|never|shall\s+not|no|not)(?![a-z])/i;

const hasNegationSignal = (value) => {
  const text = Array.isArray(value) ? value.join(' ') : String(value ?? '');
  if (CJK_NEGATION_TOKENS.some((token) => text.includes(token))) {
    return true;
  }
  return LATIN_NEGATION_PATTERN.test(text);
};

// 条款是否带禁止语义（供 lint 的断言覆盖率检查：有禁止语义却无断言 → compile-weak 警告）
export const hasProhibitionSignal = (record) => hasNegationSignal(recordText(record));

const countHits = (tokens, text) => tokens.filter((token) => text.includes(token)).length;

const classifyRecord = (record, diffParts) => {
  const tokens = recordSignals(record);
  const addedHits = countHits(tokens, diffParts.addedText);
  const removedHits = countHits(tokens, diffParts.removedText);
  const fullHits = countHits(tokens, diffParts.fullText);
  const sourceText = normalizeText(recordText(record));
  const recordHasNegation = hasNegationSignal(sourceText);
  const addedHasNegation = hasNegationSignal(diffParts.addedText);
  const removedHasNegation = hasNegationSignal(diffParts.removedText);
  const conflict = removedHits >= 3 && (recordHasNegation || removedHasNegation) && !addedHasNegation;
  if (conflict) {
    return { kind: 'conflict', addedHits, removedHits, fullHits, addedHasNegation: addedHasNegation };
  }
  if (fullHits >= 3 || (fullHits >= 2 && (record.tags ?? []).some((tag) => diffParts.fullText.includes(tag)))) {
    return { kind: 'covered', addedHits, removedHits, fullHits, addedHasNegation: addedHasNegation };
  }
  if (addedHasNegation && recordHasNegation && fullHits >= 2) {
    return { kind: 'covered', addedHits, removedHits, fullHits, addedHasNegation: addedHasNegation };
  }
  return { kind: 'weak', addedHits, removedHits, fullHits, addedHasNegation: addedHasNegation };
};

// Deterministic semantic classifier.
// Returns { severity: ok|warning|critical, covered, weak, conflicts, notes }.
export const runCriticReview = ({ diff, recalledReqs }) => {  if (!recalledReqs?.length) {
    return {
      severity: 'ok',
      covered: [],
      weak: [],
      conflicts: [],
      notes: 'No recalled records for this patch.'
    };
  }
  const diffParts = changedLineParts(diff);
  const covered = [];
  const weak = [];
  const conflicts = [];
  const classifications = [];
  for (const record of recalledReqs) {
    const result = classifyRecord(record, diffParts);
    classifications.push({ id: `${record.scope}:${record.id}`, ...result });
    if (result.kind === 'covered') {
      covered.push(record);
    } else if (result.kind === 'conflict') {
      conflicts.push(record);
    } else {
      weak.push(record);
    }
  }

  // P5 L1 标点感知翻转：同操作数布尔三元组的 &&↔|| / 极性互换是确定性语义反转。
  // 归因给带禁止/守卫语义的召回条款——守卫逻辑被反转正是它们要拦的事。
  const flips = detectBooleanFlip(diff);
  let flipNote = null;
  if (flips.length) {
    for (const record of recalledReqs) {
      if (!hasProhibitionSignal(record)) continue;
      if (conflicts.includes(record) || covered.includes(record)) {
        if (covered.includes(record)) {
          covered.splice(covered.indexOf(record), 1);
          conflicts.push(record);
        }
        continue;
      }
      conflicts.push(record);
      weak.splice(weak.indexOf(record), 1);
      classifications.push({
        id: `${record.scope}:${record.id}`,
        kind: 'conflict',
        flip: flips[0]
      });
    }
    if (conflicts.length) {
      flipNote = `Boolean flip: ${flips.map((f) => f.kind).join(', ')}（同操作数 &&↔|| / 极性互换）`;
    }
  }

  if (conflicts.length) {
    return {
      severity: 'critical',
      covered,
      weak,
      conflicts,
      classifications,
      flips,
      notes: flipNote
        ? `${flipNote} — 守卫语义被反转，需人工确认或 reqbank-ignore 抑制。`
        : 'Deterministic conflict signal: removed negated/guardrail terms from recalled records without replacement.'
    };
  }
  if (weak.length > 0) {
    return {
      severity: 'warning',
      covered,
      weak,
      conflicts: [],
      classifications,
      notes: 'Weak semantic coverage only; logged for audit and not used as a hard gate.'
    };
  }
  return {
    severity: 'ok',
    covered,
    weak: [],
    conflicts: [],
    classifications,
    notes: 'Recalled records have deterministic semantic coverage in the diff.'
  };
};

export const formatFinalizeFeedback = (issues) => {  if (!issues.length) {
    return '';
  }
  return [
    'Stop gate blocked:',
    ...issues.slice(0, 4).map((issue) => `- ${issue}`),
    ...(issues.length > 4 ? [`- 另有 ${issues.length - 4} 项同类问题，见 learning-log。`] : []),
    '',
    '继续真实改动或说明冲突后再结束；禁止空 patch / 临时 patch 只为触发 critic。'
  ].join('\n');
};

// LLM critic 候选选择：确定性分类为 weak、条款含否定信号、且新增侧与其证据集有交集的记录。
// 这类「新增行为可能踩中禁止条款」的场景是确定性分类器的盲区，交给 llm-critic 复核。
export const selectProhibitionCandidates = (recalledReqs, diff) => {
  const diffParts = changedLineParts(diff);
  return (recalledReqs ?? [])
    .map((record) => ({ record, result: classifyRecord(record, diffParts) }))
    .filter(({ record, result }) =>
      result.kind !== 'conflict'
      && !result.addedHasNegation
      && hasNegationSignal(recordText(record))
      && result.addedHits >= 2
    )
    .map(({ record, result }) => ({ record, addedHits: result.addedHits }));
};
