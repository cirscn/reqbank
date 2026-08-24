#!/usr/bin/env node
// P0 回归评测：验证 2026-08-24 修复的四类问题（B1 千位 ID / B2 段名兼容 / B3 verify 日志 /
// B8 重复 ID）+ cache-stable 断言（同 payload 两次召回注入逐字节一致）。
//
// 用法：node eval/p0-regression.mjs
// 自包含：临时真源 = 官方模板 + demo 模块，不依赖外部仓库。

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = join(KIT_ROOT, 'engine');
const BIN = join(KIT_ROOT, 'bin', 'harness.mjs');
const ROOT = join(tmpdir(), `reqbank-p0-eval-${Date.now().toString(36)}`);

const REQ_MD = `## 索引

REQ-001 | address | TC-001 | 正常条目
REQ-1000 | billing | TC-1000 | 千位条目

## 需求澄清

REQ-001: 正常条目澄清
REQ-1000: 千位条目澄清
`;

// 段名用旧写法 ## 索引（llms.txt/README 旧示例的写法，B2 兼容对象）
const TESTS_MD_LEGACY = `## 索引

TC-001 | address | REQ-001 | 地址验证
TC-1000 | billing | REQ-1000 | 千位验证

## 测试用例

TC-001: G=数据存在 | W=修改映射 | E=不回退 | V=\`echo ok\`
TC-1000: G=数据存在 | W=修改映射 | E=不回退 | V=\`echo ok1000\`
`;

const TESTS_MD_CANONICAL = TESTS_MD_LEGACY.replace('## 索引', '## 内容索引');

const REQ_MD_DUP = `## 索引

REQ-001 | address | TC-001 | 先写条目
REQ-001 | address | TC-001 | 后写条目

## 需求澄清

REQ-001: 澄清正文
`;

const results = [];
const test = (id, name, pass, evidence = '') => {
  results.push({ id, pass });
  console.log(`${pass ? '✓' : '✗'} [${id}] ${name}${evidence ? ` — ${evidence}` : ''}`);
};

const modDir = () => join(ROOT, '.agentdoc', 'harness', 'modules', 'demo');
const writeModule = (requirementsMd, testsMd) => {
  writeFileSync(join(modDir(), 'requirements.md'), requirementsMd);
  writeFileSync(join(modDir(), 'tests.md'), testsMd);
};

const buildRoot = () => {
  rmSync(ROOT, { recursive: true, force: true });
  const harnessDir = join(ROOT, '.agentdoc', 'harness');
  cpSync(join(KIT_ROOT, 'templates', 'harness'), harnessDir, { recursive: true });
  mkdirSync(modDir(), { recursive: true });
  writeFileSync(join(modDir(), 'index.md'), '## 命中路径\n\n- `src/demo/` [strong] | address,billing\n');
  writeModule(REQ_MD, TESTS_MD_LEGACY);
};

const spawnAt = (command, args, { input, extraEnv = {} } = {}) =>
  spawnSync(process.execPath, [command, ...args], {
    input,
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, HARNESS_PROJECT_ROOT: ROOT, ...extraEnv },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120000
  });

buildRoot();
process.env.HARNESS_PROJECT_ROOT = ROOT;
const store = await import(join(ENGINE, 'lib', 'harness-store.mjs'));

// ── B1：千位 ID 可解析、可召回 ────────────────────────────────
const reqs = store.loadAllRequirements();
const tcs = store.loadAllTests();
test('B1', 'REQ-1000 / TC-1000 正常解析',
  reqs.some((r) => r.id === 'REQ-1000') && tcs.some((t) => t.id === 'TC-1000'),
  `requirements=${reqs.length} 条（${reqs.map((r) => r.id).join(',')}）tests=${tcs.length} 条（${tcs.map((t) => t.id).join(',')}）`);
const req1000 = reqs.find((r) => r.id === 'REQ-1000');
test('B1', '千位条目的澄清正文与 GWEV 字段完整挂载',
  req1000?.clarification === '千位条目澄清' && (tcs.find((t) => t.id === 'TC-1000')?.verify?.[0] ?? '').includes('echo ok1000'));

// ── B2：旧段名 ## 索引 兼容 + 规范段名等价 ──────────────────────
test('B2', 'tests.md 旧段名 ## 索引 可解析（当前真源即旧段名）', tcs.length === 2);
writeModule(REQ_MD, TESTS_MD_CANONICAL);
const tcsCanonical = store.loadAllTests();
test('B2', '规范段名 ## 内容索引 解析结果与旧段名等价',
  tcsCanonical.length === 2 && tcsCanonical.map((t) => t.id).sort().join(',') === 'TC-001,TC-1000');
writeModule(REQ_MD, TESTS_MD_LEGACY);

// ── B8：重复 ID → check 失败，修复后恢复 ───────────────────────
writeModule(REQ_MD_DUP, TESTS_MD_LEGACY);
store.loadAllRequirements();
const dupWarnings = store.consumeParseWarnings().filter((w) => w.code === 'duplicate-id');
test('B8', '重复 ID 产生 duplicate-id 解析错误',
  dupWarnings.length === 1 && dupWarnings[0].kind === 'error',
  dupWarnings[0]?.message ?? '无警告');
const checkDup = spawnAt(BIN, ['check']);
test('B8', 'reqbank check 对重复 ID exit 1 并指明条款',
  checkDup.status === 1 && /duplicate-id/.test(`${checkDup.stdout}${checkDup.stderr}`),
  `exit=${checkDup.status}`);

writeModule(REQ_MD, TESTS_MD_LEGACY);
const checkClean = spawnAt(BIN, ['check']);
test('B8', '去重后 check 恢复 exit 0', checkClean.status === 0,
  `exit=${checkClean.status}${checkClean.status !== 0 ? ` ${checkClean.stderr.trim().slice(0, 200)}` : ''}`);

// ── 未知段名：warning 不阻断 ─────────────────────────────────
writeModule(REQ_MD + '\n## 备注\n\n人读内容，机器不解析。\n', TESTS_MD_LEGACY);
const checkUnknown = spawnAt(BIN, ['check']);
test('B2+', '未知段名给出 warning 但不阻断（exit 0）',
  checkUnknown.status === 0 && /unknown-section.*备注/.test(`${checkUnknown.stdout}${checkUnknown.stderr}`),
  `exit=${checkUnknown.status}`);
writeModule(REQ_MD, TESTS_MD_LEGACY);

// ── cache-stable：同 payload 两次召回注入逐字节一致 ─────────────
const payload = JSON.stringify({
  event: 'UserPromptSubmit',
  prompt: '修复 src/demo/ 地址映射的回退问题',
  session_id: 'p0-eval-session',
  turn_id: 'p0-eval-turn-1'
});
const runRecall = () => spawnAt(join(ENGINE, 'recall.mjs'), [], { input: payload });
const recallA = runRecall();
const recallB = runRecall();
test('CS', 'cache-stable：同 payload 两次 recall 输出逐字节一致',
  recallA.stdout === recallB.stdout && recallA.stdout.includes('additionalContext'),
  `输出长度 ${recallA.stdout.length}，含 additionalContext=${recallA.stdout.includes('additionalContext')}`);

// ── B3：verify 执行后写 learning-log（event: verify）────────────
const logPath = join(ROOT, '.agentdoc', 'harness', 'learning-log.jsonl');
const logLinesBefore = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length : 0;
const verifyRun = spawnAt(join(ENGINE, 'verify.mjs'), ['--tc', 'demo:TC-001', '--tc', 'demo:TC-1000']);
const verifyEvents = existsSync(logPath)
  ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).filter((e) => e.event === 'verify')
  : [];
test('B3', 'verify 逐条写 learning-log（event: verify）',
  verifyRun.status === 0 && verifyEvents.length >= 2
  && verifyEvents.every((e) => e.tc && typeof e.exit === 'number' && e.ok === true && typeof e.duration_ms === 'number'),
  `exit=${verifyRun.status}，verify 事件 ${verifyEvents.length} 条：${verifyEvents.map((e) => `${e.tc}(${e.command})`).join('、')}`);

// ── 汇总 ───────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
console.log(`\n═══ P0 回归：${results.length - failed.length}/${results.length} 通过 ═══`);
if (failed.length) {
  for (const f of failed) console.log(`  失败：${f.id}`);
  process.exit(1);
}
rmSync(ROOT, { recursive: true, force: true });
