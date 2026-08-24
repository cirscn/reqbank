#!/usr/bin/env node
// harness impact <file...> —— 打印改动文件的调用邻居（基于 .mex/graph.db，若存在）。
// JSONL 输出：meta / neighbor 行。无图或无邻居时 status=empty。

import { expandPathsViaGraph } from './lib/impact.mjs';

const files = process.argv.slice(2);
process.stdout.write(`${JSON.stringify({ type: 'meta', command: 'harness impact', files })}\n`);
const { expanded, source } = expandPathsViaGraph({ rootPath: process.cwd(), changedPaths: files });
for (const filePath of expanded) {
  process.stdout.write(`${JSON.stringify({ type: 'neighbor', file: filePath, source })}\n`);
}
process.stdout.write(`${JSON.stringify({ type: 'done', status: expanded.length ? 'ok' : 'empty', source: source ?? 'none', count: expanded.length })}\n`);
