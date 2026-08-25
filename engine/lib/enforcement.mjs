// 执法分级：四层（PreToolUse / critic / Stop / gate）同一口径。
//   - diff 中 `reqbank-ignore: <scope:id>` → 该条款冲突降级，不硬拦（counted）
//   - 索引第 5 列 `:warn` → 同样降级不硬拦（counted）
// 硬拦只认未降级的断言命中。

export const formatScopedId = (record) => `${record.scope}:${record.id}`;

export const isInlineIgnored = (diffText, record) =>
  String(diffText ?? '').includes(`reqbank-ignore: ${formatScopedId(record)}`);

export const uniqueRecords = (records) => {
  const seen = new Set();
  const out = [];
  for (const record of records ?? []) {
    const key = formatScopedId(record);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
};

export const partitionRecords = (records, diffText) => {
  const blocking = [];
  const warned = [];
  const ignored = [];
  for (const record of records ?? []) {
    if (isInlineIgnored(diffText, record)) ignored.push(record);
    else if (record.enforcement === 'warn') warned.push(record);
    else blocking.push(record);
  }
  return { blocking, warned, ignored };
};

export const partitionAssertionHits = (hits, diffText) => {
  const blocking = [];
  const warned = [];
  const ignored = [];
  for (const hit of hits ?? []) {
    const scopedId = formatScopedId(hit.record);
    if (isInlineIgnored(diffText, hit.record)) ignored.push({ ...hit, scopedId });
    else if (hit.record.enforcement === 'warn') warned.push({ ...hit, scopedId });
    else blocking.push({ ...hit, scopedId });
  }
  return { blocking, warned, ignored };
};
