// Templates and helpers for deterministic harness critic signals.
// The critic classifies recalled records as covered / weak / conflict without
// injecting full REQ/TC bodies. A later LLM critic can replace runCriticReview
// without changing hook callsites or log field names.

const formatRecord = (record) => {
  const tags = record.tags?.length ? ` [${record.tags.join(', ')}]` : '';
  return `${record.scope}:${record.id}${tags} - ${record.title || 'untitled'} (${record.file})`;
};

export const formatRecallContext = (records) => {
  if (!records.length) {
    return '';
  }
  const lines = ['Harness Recall IDs:'];
  for (const record of records) {
    lines.push(`- ${formatRecord(record)}`);
  }
  return lines.join('\n');
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

  if (conflicts.length) {
    return {
      severity: 'critical',
      covered,
      weak,
      conflicts,
      classifications,
      notes: 'Deterministic conflict signal: removed negated/guardrail terms from recalled records without replacement.'
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
