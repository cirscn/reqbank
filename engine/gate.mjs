#!/usr/bin/env node
// reqbank gate —— CI / pre-commit 判决入口（P2「one engine, one verdict」）。
// 与 PostToolUse critic / Stop 终态裁决复用同一套硬拦判定（recallByPaths + 断言层；无断言不 block），
// 本地钩子与流水线不会出现「同一改动两套结论」。
//
// 用法：
//   node gate.mjs [--staged] [--base <ref>] [--json]
//     --staged   只判 git diff --cached（pre-commit 场景）
//     --base ref 判 git diff <ref>（CI 场景，如 origin/main）
//     默认        判工作区全部未提交改动（unstaged+staged+untracked 业务文件）
// 退出码：0 无确定性冲突；1 存在冲突；2 引擎自身故障（fail-closed——门禁场景崩溃≠通过）。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extractKeywords, loadAssertionBearers, matchPathPattern, recallByPaths } from './lib/harness-store.mjs';
import { mergeAssertionPool, runAssertionReview } from './lib/assertions.mjs';
import { getBusinessFileUnifiedDiff, isBusinessFile } from './lib/dirty-files.mjs';
import { getProjectRoot, repoPath } from './lib/repo-paths.mjs';
import { appendLog } from './lib/learning-log.mjs';

const git = (args) => execFileSync('git', args, { cwd: getProjectRoot(), encoding: 'utf8' });

const changedFilesFor = (mode, baseRef) => {
  if (mode === 'staged') {
    return git(['diff', '--cached', '--name-only', '-z']).split('\0').map((f) => f.trim()).filter(Boolean);
  }
  if (mode === 'base') {
    return git(['diff', baseRef, '--name-only', '-z']).split('\0').map((f) => f.trim()).filter(Boolean);
  }
  // 默认：工作区三路合并（unstaged + staged + untracked），只看业务文件
  const files = new Set();
  for (const args of [['diff', '--name-only', '-z'], ['diff', '--name-only', '--cached', '-z'], ['ls-files', '--others', '--exclude-standard', '-z']]) {
    for (const file of git(args).split('\0').map((f) => f.trim()).filter(Boolean)) {
      files.add(file);
    }
  }
  return [...files].filter(isBusinessFile).sort();
};

const diffFor = (file, mode, baseRef) => {
  try {
    if (mode === 'staged') {
      return git(['diff', '--cached', '--', file]);
    }
    if (mode === 'base') {
      return git(['diff', baseRef, '--', file]);
    }
    return getBusinessFileUnifiedDiff(file);
  } catch {
    return '';
  }
};

const SOURCE_LABEL = { assertion: '断言命中' };

const main = async () => {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const baseIndex = args.indexOf('--base');
  const baseRef = baseIndex > -1 ? args[baseIndex + 1] : null;
  const mode = args.includes('--staged') ? 'staged' : baseRef ? 'base' : 'dirty';
  if (baseIndex > -1 && !baseRef) {
    console.error('[reqbank gate] --base 需要一个 ref 参数');
    process.exit(2);
  }

  const files = changedFilesFor(mode, baseRef);
  const assertionBearers = loadAssertionBearers(); // 循环外一次：避免每文件全库重解析
  const conflicts = [];
  for (const file of files) {
    const diff = diffFor(file, mode, baseRef);
    if (!diff.trim()) {
      continue; // untracked 新文件无 git diff、或 diff 为空
    }
    const recalled = recallByPaths([file], {
      keywords: extractKeywords(diff),
      recordKind: 'req-only',
      moduleQuota: 2
    });
    if (!recalled.length) {
      continue;
    }
    const assertionHits = await runAssertionReview({
      diff,
      filePaths: [file],
      recalledReqs: mergeAssertionPool(recalled, assertionBearers),
      matchPathPattern
    });
    for (const hit of assertionHits) {
      conflicts.push({
        id: `${hit.record.scope}:${hit.record.id}`,
        file,
        source: 'assertion',
        detail: `${hit.kind}:${hit.pattern} —— ${hit.matchedLine.slice(0, 80)}`
      });
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const conflict of conflicts) {
    const key = `${conflict.id}|${conflict.file}|${conflict.source}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(conflict);
    }
  }

  // P3 冻结基线（OpenLore frozen 棘轮）：--freeze 把当前冲突快照为存量（只警告不阻断）；
  // 之后新增冲突照常 block。基线文件损坏 → exit 2（fail-closed，防静默失去保护）。
  const baselinePath = repoPath('.agentdoc', 'harness', 'gate-baseline.json');
  if (args.includes('--freeze')) {
    writeFileSync(baselinePath, `${JSON.stringify({ frozen_at: new Date().toISOString(), ids: [...new Set(deduped.map((c) => c.id))] }, null, 2)}\n`);
    console.log(`[reqbank gate] 已冻结 ${new Set(deduped.map((c) => c.id)).size} 个存量冲突 → ${baselinePath}（此后仅新增冲突阻断）`);
    process.exit(0);
  }
  let frozenIds = new Set();
  if (existsSync(baselinePath)) {
    try {
      frozenIds = new Set(JSON.parse(readFileSync(baselinePath, 'utf8')).ids ?? []);
    } catch (error) {
      console.error(`[reqbank gate] gate-baseline.json 无法解析（${error.message}）——fail-closed`);
      process.exit(2);
    }
  }
  const known = deduped.filter((c) => frozenIds.has(c.id));
  const fresh = deduped.filter((c) => !frozenIds.has(c.id));

  appendLog({
    event: 'gate',
    gate_mode: mode,
    base_ref: baseRef,
    files_scanned: files.length,
    conflict_ids: [...new Set(fresh.map((c) => c.id))],
    frozen_conflict_ids: [...new Set(known.map((c) => c.id))],
    conflicts: fresh,
    passed: fresh.length === 0
  });

  if (asJson) {
    console.log(JSON.stringify({ passed: fresh.length === 0, mode, files: files.length, frozen: known.length, conflicts: fresh }, null, 2));
  } else {
    for (const conflict of known) {
      console.error(`  ~ ${conflict.id} @ ${conflict.file}（冻结存量，仅警告）${conflict.detail}`);
    }
    if (fresh.length) {
      console.error(`[reqbank gate] ✗ ${fresh.length} 项新增确定性冲突：`);
      for (const conflict of fresh) {
        console.error(`  - ${conflict.id} @ ${conflict.file}（${SOURCE_LABEL[conflict.source]}）${conflict.detail}`);
      }
      console.error('修复冲突或更新契约后再提交；确属存量可 `reqbank gate --freeze` 冻结。硬拦只认「## 断言」命中。');
    } else {
      console.log(`[reqbank gate] ✓ 通过（${mode}，扫描 ${files.length} 个文件${known.length ? `，${known.length} 项冻结存量仅警告` : ''}）`);
    }
  }
  process.exit(fresh.length ? 1 : 0);
};

main().catch((error) => {
  // 门禁场景 fail-closed：引擎崩溃绝不等于检查通过（对照钩子场景的 fail-open）
  console.error(`[reqbank gate] fatal: ${error.message}`);
  process.exit(2);
});
