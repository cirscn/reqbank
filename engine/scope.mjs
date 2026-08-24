#!/usr/bin/env node
// harness scope <task...> — 任务 → 需求/测试证据链（JSONL 协议，供 agent 消费）。
// 参考 mex 的 source-backed retrieval：每条命中带 id、标签、标题、澄清正文、关联 TC 与真源文件路径。
//
// 用法：
//   node scope.mjs "修复 useFetch 的错误提示去重问题"
//   node scope.mjs --json --top 5 "首页 KPI loading"
//   echo "任务描述" | node scope.mjs -

import { extractKeywords, extractPathCandidates, recallByKeywords, recallByPaths } from './lib/harness-store.mjs';
import { loadAllTests } from './lib/harness-store.mjs';

const parseArgs = (argv) => {
  const options = { json: false, top: 3, task: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--top') {
      index += 1;
      options.top = Number(argv[index]) || 3;
    } else {
      options.task.push(arg);
    }
  }
  return options;
};

const emit = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  let prompt = options.task.join(' ').trim();

  if (prompt === '-' || !prompt) {
    let data = '';
    for await (const chunk of process.stdin) {
      data += chunk;
    }
    prompt = data.trim();
  }

  const startedAt = Date.now();
  emit({
    type: 'meta',
    command: 'harness scope',
    protocolVersion: 1,
    top: options.top,
    task: prompt || null
  });

  if (!prompt) {
    emit({ type: 'error', message: 'empty task: pass a task string or pipe via stdin' });
    process.exit(2);
  }

  const keywords = extractKeywords(prompt);
  const pathCandidates = extractPathCandidates(prompt);
  const pathRecalled = pathCandidates.length ? recallByPaths(pathCandidates, { topK: options.top, keywords }) : [];
  const recalled = pathRecalled.length ? pathRecalled : recallByKeywords(keywords, { topK: options.top });
  const strategy = pathRecalled.length ? 'paths' : 'keywords';
  const tests = loadAllTests();
  const testById = new Map(tests.map((record) => [`${record.scope}:${record.id}`, record]));

  emit({
    type: 'summary',
    strategy,
    pathCandidates,
    keywordCount: keywords.length,
    hits: recalled.length
  });

  for (const record of recalled) {
    const relatedTests = (record.relatedTests ?? [])
      .map((id) => testById.get(`${record.scope}:${id}`))
      .filter(Boolean)
      .map((testCase) => ({
        id: `${testCase.scope}:${testCase.id}`,
        title: testCase.title ?? null,
        trigger: testCase.trigger ?? null,
        mustVerify: testCase.mustVerify ?? null,
        verify: testCase.verify?.[0] ?? null
      }));
    emit({
      type: 'requirement',
      id: `${record.scope}:${record.id}`,
      tags: record.tags ?? [],
      title: record.title,
      clarification: record.clarification || null,
      source: record.file,
      relatedTests
    });
  }

  emit({
    type: 'done',
    status: recalled.length ? 'ok' : 'empty',
    elapsedMs: Date.now() - startedAt,
    hint: recalled.length
      ? '实现前先读上述 requirement 的 clarification 与 relatedTests.mustVerify；完成后按 verify 命令验证。'
      : '未命中已建模块。若形成持久业务契约或可复用 bug 修复，提交前需沉淀新 REQ/TC。'
  });
};

main().catch((error) => {
  emit({ type: 'error', message: error.message });
  process.exit(0);
});
