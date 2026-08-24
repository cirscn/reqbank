#!/usr/bin/env node
// P6 版本体验回归：升级提醒（update-check）+ 版本说明（changelog）。
//   ① 单元：compareSemver / checkForUpdate（可注入 fetch：新版本/同版/网络失败/缓存命中/缓存过期/env 关闭）
//   ② 端到端：session-init 注入升级提醒行（缓存驱动，零网络）/ HARNESS_SKIP_UPDATE_CHECK=1 关闭
//   ③ CLI：reqbank changelog（最新/指定版本/--all/未知版本 exit 1）/ version 缓存回显
//   ④ 分发：npm files 含 CHANGELOG.md；init 幂等落 .harness/CHANGELOG.md + VERSION；gitignore 含 update-check.json
// 用法：node eval/update-changelog.mjs

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(KIT_ROOT, 'bin', 'harness.mjs');
const ENGINE = join(KIT_ROOT, 'engine');

const results = [];
const test = (id, name, pass, evidence = '') => {
  results.push({ id, pass });
  console.log(`${pass ? '✓' : '✗'} [${id}] ${name}${evidence ? ` — ${evidence}` : ''}`);
};
const spawnAt = (root, command, args, { input, extraEnv = {} } = {}) =>
  spawnSync(process.execPath, [command, ...args], {
    input, cwd: root, encoding: 'utf8',
    env: { ...process.env, HARNESS_PROJECT_ROOT: root, ...extraEnv },
    maxBuffer: 32 * 1024 * 1024, timeout: 60000
  });
const gitAt = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });

// ── ① 单元：update-check ────────────────────────────────
{
  const { compareSemver, checkForUpdate } = await import(join(ENGINE, 'lib', 'update-check.mjs'));
  test('SEMV', 'semver 比较：0.9.0 < 0.10.0 < 0.10.1 < 0.11.0，v 前缀容忍',
    compareSemver('0.9.0', '0.10.0') < 0 && compareSemver('0.10.0', '0.10.1') < 0
    && compareSemver('0.10.1', '0.11.0') < 0 && compareSemver('v0.11.0', '0.11.0') === 0
    && compareSemver('0.11.0', '0.11.0') === 0);

  const scratch = mkdtempSync(join(tmpdir(), 'reqbank-uc-'));
  const cachePath = join(scratch, 'update-check.json');
  const mkFetch = (latest, log) => async () => {
    log.calls += 1;
    if (latest === null) throw new Error('offline');
    return { ok: true, json: async () => ({ 'dist-tags': { latest } }) };
  };

  // 新版本可用
  const log1 = { calls: 0 };
  let r = await checkForUpdate({ currentVersion: '0.10.0', fetchImpl: mkFetch('0.11.0', log1), cachePath });
  test('UC-AVAIL', 'registry 有新版 → status=available',
    r.status === 'available' && r.latest === '0.11.0' && r.checkedVia === 'registry');

  // 缓存命中：第二次零网络
  const log2 = { calls: 0 };
  r = await checkForUpdate({ currentVersion: '0.10.0', fetchImpl: mkFetch('0.11.0', log2), cachePath });
  test('UC-CACHE', '24h 缓存命中 → 零网络请求',
    r.checkedVia === 'cache' && r.status === 'available' && log2.calls === 0, `via=${r.checkedVia} calls=${log2.calls}`);

  // 缓存过期 → 重新请求
  const stale = { checkedAt: Date.now() - 25 * 60 * 60 * 1000, latest: '0.11.0' };
  writeFileSync(cachePath, JSON.stringify(stale));
  const log3 = { calls: 0 };
  r = await checkForUpdate({ currentVersion: '0.10.0', fetchImpl: mkFetch('0.11.0', log3), cachePath });
  test('UC-STALE', '缓存过期（>24h）→ 重新走网络',
    log3.calls === 1 && r.checkedVia === 'registry', `calls=${log3.calls}`);

  // 同版本 → latest
  r = await checkForUpdate({ currentVersion: '0.11.0', fetchImpl: mkFetch('0.11.0', { calls: 0 }), cachePath: join(scratch, 'c2.json') });
  test('UC-SAME', '已装即最新 → status=latest', r.status === 'latest');

  // 网络失败 → unknown 且不写缓存
  const cachePath3 = join(scratch, 'c3.json');
  r = await checkForUpdate({ currentVersion: '0.10.0', fetchImpl: mkFetch(null, { calls: 0 }), cachePath: cachePath3 });
  test('UC-OFFLINE', '离线/网络失败 → unknown 静默且不写缓存',
    r.status === 'unknown' && !existsSync(cachePath3), `via=${r.checkedVia}`);

  // env 关闭
  const prev = process.env.HARNESS_SKIP_UPDATE_CHECK;
  process.env.HARNESS_SKIP_UPDATE_CHECK = '1';
  r = await checkForUpdate({ currentVersion: '0.10.0', fetchImpl: mkFetch('0.99.0', { calls: 0 }), cachePath: null });
  process.env.HARNESS_SKIP_UPDATE_CHECK = prev;
  test('UC-ENV-OFF', 'HARNESS_SKIP_UPDATE_CHECK=1 → disabled 零请求', r.status === 'disabled');

  // 坏缓存容错
  writeFileSync(cachePath, '{not json');
  r = await checkForUpdate({ currentVersion: '0.10.0', fetchImpl: mkFetch('0.11.0', { calls: 0 }), cachePath });
  test('UC-BADCACHE', '缓存损坏 → 忽略并回退网络', r.checkedVia === 'registry');
  rmSync(scratch, { recursive: true, force: true });
}

// ── ② 端到端：session-init 提醒注入 ─────────────────────
{
  const root = join(tmpdir(), `reqbank-uc-e2e-${Date.now().toString(36)}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  gitAt(root, ['init', '-q']);
  const initRun = spawnAt(root, BIN, ['init', '--agents', 'codex']);
  // 缓存预置新版（缓存驱动 → 测试零网络）
  writeFileSync(join(root, '.agentdoc', 'harness', 'update-check.json'),
    JSON.stringify({ checkedAt: Date.now(), latest: '99.0.0' }));
  const sessionRun = spawnAt(root, join(ENGINE, 'session-init.mjs'), [], {
    input: JSON.stringify({ session_id: 'uc', source: 'startup' })
  });
  const context = JSON.parse(sessionRun.stdout).hookSpecificOutput?.additionalContext ?? '';
  test('SI-REMIND', 'session-init：缓存指示有新版 → 注入升级提醒行',
    initRun.status === 0 && context.includes('新版本可用') && context.includes('99.0.0'),
    context.split('\n').find((l) => l.includes('新版本')) ?? '(none)');

  // 已装即最新（缓存指向当前版本）→ 无提醒行
  writeFileSync(join(root, '.agentdoc', 'harness', 'update-check.json'),
    JSON.stringify({ checkedAt: Date.now(), latest: readFileSync(join(root, '.harness', 'VERSION'), 'utf8').trim() }));
  const sessionRun2 = spawnAt(root, join(ENGINE, 'session-init.mjs'), [], {
    input: JSON.stringify({ session_id: 'uc', source: 'startup' })
  });
  const context2 = JSON.parse(sessionRun2.stdout).hookSpecificOutput?.additionalContext ?? '';
  test('SI-QUIET', '已是最新 → 无提醒行（不打扰）', !context2.includes('新版本可用'));

  // env 关闭 → 无提醒（即使缓存指示有新版）
  writeFileSync(join(root, '.agentdoc', 'harness', 'update-check.json'),
    JSON.stringify({ checkedAt: Date.now(), latest: '99.0.0' }));
  const sessionRun3 = spawnAt(root, join(ENGINE, 'session-init.mjs'), [], {
    input: JSON.stringify({ session_id: 'uc', source: 'startup' }),
    extraEnv: { HARNESS_SKIP_UPDATE_CHECK: '1' }
  });
  const context3 = JSON.parse(sessionRun3.stdout).hookSpecificOutput?.additionalContext ?? '';
  test('SI-ENV-OFF', 'HARNESS_SKIP_UPDATE_CHECK=1 → 无提醒', !context3.includes('新版本可用'));
  rmSync(root, { recursive: true, force: true });
}

// ── ③ CLI：changelog / version ──────────────────────────
{
  const root = join(tmpdir(), `reqbank-uc-cli-${Date.now().toString(36)}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  gitAt(root, ['init', '-q']);
  spawnAt(root, BIN, ['init', '--agents', 'codex']);

  const latest = spawnAt(root, BIN, ['changelog']);
  test('CL-LATEST', 'reqbank changelog：显示最新版本段（含版本号与要点）',
    latest.status === 0 && /## 0\.\d+\.\d+/.test(latest.stdout) && latest.stdout.includes('**'),
    (latest.stdout.match(/## [^\n]+/) ?? ['(none)'])[0]);

  const specific = spawnAt(root, BIN, ['changelog', '0.10.0']);
  test('CL-VERSION', 'reqbank changelog 0.10.0：定位指定版本段',
    specific.status === 0 && specific.stdout.includes('tree-sitter'),
    (specific.stdout.match(/## [^\n]+/) ?? ['(none)'])[0]);

  const all = spawnAt(root, BIN, ['changelog', '--all']);
  test('CL-ALL', 'reqbank changelog --all：全量输出', all.status === 0 && all.stdout.includes('## 0.9.0'));

  const missing = spawnAt(root, BIN, ['changelog', '0.0.1']);
  test('CL-MISSING', '未知版本 → exit 1 且给出指引', missing.status === 1 && /全部/.test(missing.stderr));

  const ver = spawnAt(root, BIN, ['version']);
  const installed = readFileSync(join(root, '.harness', 'VERSION'), 'utf8').trim();
  test('CL-VERSION-CMD', 'reqbank version：显示已装版本',
    ver.status === 0 && ver.stdout.includes(installed), ver.stdout.trim());

  // version 缓存驱动显示 latest 提示
  writeFileSync(join(root, '.agentdoc', 'harness', 'update-check.json'),
    JSON.stringify({ checkedAt: Date.now(), latest: '99.0.0' }));
  const ver2 = spawnAt(root, BIN, ['version']);
  test('CL-VERSION-UPDATE', 'reqbank version：缓存指示有新版 → 附升级提示',
    ver2.stdout.includes('99.0.0') && ver2.stdout.includes('update'), ver2.stdout.trim());

  // init 分发验证：.harness/CHANGELOG.md 落盘 + gitignore 含 update-check.json
  test('DIST-INIT', 'init 落 .harness/CHANGELOG.md 且 .gitignore 含 update-check.json',
    existsSync(join(root, '.harness', 'CHANGELOG.md'))
    && readFileSync(join(root, '.gitignore'), 'utf8').includes('update-check.json'));
  rmSync(root, { recursive: true, force: true });

  // npm files 清单含 CHANGELOG.md（随包分发的静态断言）
  const pkg = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8'));
  test('DIST-NPM', 'package.json files 含 CHANGELOG.md', (pkg.files ?? []).includes('CHANGELOG.md'));
}

// ── 汇总 ─────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
console.log(`\n═══ P6 版本体验回归：${results.length - failed.length}/${results.length} 通过 ═══`);
if (failed.length) {
  for (const f of failed) console.log(`  失败：${f.id}`);
  process.exit(1);
}
