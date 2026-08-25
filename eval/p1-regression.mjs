#!/usr/bin/env node
// P1 回归评测：验证 P1 五项交付——
//   ① trace-integrity lint（悬挂/不对称/无TC/模块漂移）② Stop 终态裁决（B7 真实复现）
//   ③ 注入预算协议 ④ 分层注入（禁止类正文直注）⑤ critic req-only + 每模块配额 + 召回配置数据化
// 用法：node eval/p1-regression.mjs（①-④ 自包含临时真源；⑤ 跑在 bpms 真实 fixture 上）

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = join(KIT_ROOT, 'engine');
const BIN = join(KIT_ROOT, 'bin', 'harness.mjs');
const BPMS = '/Users/aaron/Project/cirscn/bpms/frontend';

const results = [];
const test = (id, name, pass, evidence = '') => {
  results.push({ id, pass });
  console.log(`${pass ? '✓' : '✗'} [${id}] ${name}${evidence ? ` — ${evidence}` : ''}`);
};

const md = (lines) => lines.join('\n') + '\n';
const spawnAt = (root, command, args, { input, extraEnv = {} } = {}) =>
  spawnSync(process.execPath, [command, ...args], {
    input, cwd: root, encoding: 'utf8',
    env: { ...process.env, HARNESS_PROJECT_ROOT: root, ...extraEnv },
    maxBuffer: 32 * 1024 * 1024, timeout: 120000
  });
const gitAt = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });

// ── 基础真源：templates + demo 模块 ─────────────────────────
const GUARD_FILE = 'src/demo/guard.ts';
const GUARD_LINES = [
  '  if (isMessageHandledError(error)) return;',
  '  // 守卫缺失会让同一错误重复弹出',
  '  throw toRequestError(error);'
];
const REQ_MD = `## 索引

REQ-001 | error-feedback,guard-dedup | TC-001 | 已处理错误不得重复弹出
REQ-002 | success-path | TC-002 | 正向提示通路

## 需求澄清

REQ-001: 全局拦截里 isMessageHandledError 命中的已处理错误必须直接 return 跳过，不得再经 toRequestError 抛出——守卫缺失会让同一错误重复弹出。
REQ-002: 成功回执展示统一走成功通路组件，由调用方声明展示时机。

## 断言

REQ-001 | no-delete | isMessageHandledError
`;
const TESTS_MD = `## 内容索引

TC-001 | error-feedback | REQ-001 | 守卫验证
TC-002 | request | REQ-002 | 通路验证

## 测试用例

TC-001: G=守卫在位 | W=触发拦截 | E=仅提示一次 | V=\`node -e "if(!require('fs').existsSync('package.json'))process.exit(1)"\`
TC-002: G=成功回执 | W=展示 | E=走成功通路 | V=\`node -e "if(!require('fs').existsSync('package.json'))process.exit(1)"\`
`;

const buildRoot = (root, requirementsMd = REQ_MD, testsMd = TESTS_MD, registeredExtra = '') => {
  rmSync(root, { recursive: true, force: true });
  const harnessDir = join(root, '.agentdoc', 'harness');
  cpSync(join(KIT_ROOT, 'templates', 'harness'), harnessDir, { recursive: true });
  const mod = join(harnessDir, 'modules', 'demo');
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, 'index.md'), '## 命中路径\n\n- `src/demo/` [strong] | error-feedback,guard-dedup,request,success-path\n');
  writeFileSync(join(mod, 'requirements.md'), requirementsMd);
  writeFileSync(join(mod, 'tests.md'), testsMd);
  writeFileSync(join(harnessDir, 'index.md'), md([
    '# 索引', '', '## 已建模块', '',
    `demo | .agentdoc/harness/modules/demo/ | demo 契约${registeredExtra}`,
    '', '## 待初始化高风险模块', '', '（暂无）', ''
  ]));
  rmSync(join(harnessDir, 'modules', '_template'), { recursive: true, force: true });
};

// ══ ① trace-integrity lint ═══════════════════════════════
{
  const root = join(tmpdir(), `reqbank-p1-trace-${Date.now().toString(36)}`);
  const reqs = (body) => REQ_MD.replace('REQ-001 | error-feedback,guard-dedup | TC-001 |', body);

  buildRoot(root); // 干净基线
  const clean = spawnAt(root, BIN, ['check']);
  test('T0', '干净真源 check 通过（trace-integrity 不误报）', clean.status === 0,
    clean.status === 0 ? '' : `stderr=${clean.stderr.trim().slice(0, 300)}`);

  buildRoot(root, reqs('REQ-001 | error-feedback,guard-dedup | TC-999 |')); // 悬挂 TC
  const dangling = spawnAt(root, BIN, ['check']);
  test('T1', '悬挂 TC 引用 → check exit 1 并指明',
    dangling.status === 1 && /trace-integrity.*悬挂/.test(`${dangling.stdout}${dangling.stderr}`),
    (dangling.stderr.match(/trace-integrity:.*悬挂[^\n]*/) ?? [''])[0].slice(0, 90));

  const ASYM_TESTS = TESTS_MD.replace('TC-002 | request | REQ-002 |', 'TC-002 | request | REQ-001 |'); // TC-002 反指 REQ-001，REQ-002 仍列出 TC-002
  buildRoot(root, REQ_MD, ASYM_TESTS);
  const asym = spawnAt(root, BIN, ['check']);
  test('T2', '双向不对称链接 → check exit 1',
    asym.status === 1 && /双向不对称/.test(asym.stderr),
    (asym.stderr.match(/trace-integrity:.*不对称[^\n]*/) ?? [''])[0].slice(0, 90));

  const NO_TC = REQ_MD.replace(/REQ-002 \| success-path \| TC-002 \|/, 'REQ-002 | success-path |  |'); // REQ-002 无 TC
  buildRoot(root, NO_TC);
  const loose = spawnAt(root, BIN, ['check']);
  const strict = spawnAt(root, BIN, ['check', '--strict']);
  test('T3', '无 TC 的 REQ：铁律②警告（loose 放行 / strict 拦截）',
    loose.status === 0 && /未挂任何 TC/.test(`${loose.stdout}${loose.stderr}`) && strict.status === 1,
    `loose=${loose.status} strict=${strict.status}${loose.status !== 0 ? ` loose_stderr=${loose.stderr.trim().slice(0, 240)}` : ''}`);

  buildRoot(root, REQ_MD, TESTS_MD, '\nghost-mod | .agentdoc/harness/modules/ghost-mod/ | 不存在'); // 索引登记幽灵模块
  const drift = spawnAt(root, BIN, ['check']);
  test('T4', '模块索引漂移（登记了不存在模块）→ 警告不阻断',
    drift.status === 0 && /索引漂移.*ghost-mod/.test(`${drift.stdout}${drift.stderr}`), `exit=${drift.status}`);
  rmSync(root, { recursive: true, force: true });
}

// ══ ② Stop 终态裁决（B7 真实复现：无 critic 参与，违规直接落盘）═════════
{
  const root = join(tmpdir(), `reqbank-p1-terminal-${Date.now().toString(36)}`);
  buildRoot(root);
  mkdirSync(join(root, 'src', 'demo'), { recursive: true });
  writeFileSync(join(root, GUARD_FILE), ['export const handle = (error) => {', ...GUARD_LINES, '};', ''].join('\n'));
  gitAt(root, ['init', '-q']);
  gitAt(root, ['config', 'user.email', 'eval@reqbank']);
  gitAt(root, ['config', 'user.name', 'reqbank-eval']);
  gitAt(root, ['add', '.']);
  gitAt(root, ['commit', '-qm', 'init guard']);

  const payload = (turnId, event, extra = {}) => JSON.stringify({ cwd: root, session_id: 'p1-eval', turn_id: turnId, ...extra });
  const recall = (turnId, prompt) => spawnAt(root, join(ENGINE, 'recall.mjs'), [], {
    input: payload(turnId, 'UserPromptSubmit', { prompt })
  });
  const finalize = (turnId) => spawnAt(root, join(ENGINE, 'finalize.mjs'), [], { input: payload(turnId, 'Stop') });

  recall('t1', `修复 ${GUARD_FILE} 的错误重复弹出问题`); // 记录 baseline
  writeFileSync(join(root, GUARD_FILE), ['export const handle = (error) => {', '  notifyAlways(error);', '};', ''].join('\n')); // 删守卫，无 critic
  const blocked = finalize('t1');
  const blockedOutput = JSON.parse(blocked.stdout);
  test('S1', 'B7 复现：删守卫落盘但无 critic 事件 → Stop 终态裁决拦截',
    blockedOutput.decision === 'block' && String(blockedOutput.reason).includes('demo:REQ-001') && String(blockedOutput.reason).includes('终态裁决'),
    `decision=${blockedOutput.decision}，reason 含 REQ-001=${String(blockedOutput.reason).includes('demo:REQ-001')}`);
  const stopLog = readFileSync(join(root, '.agentdoc', 'harness', 'learning-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'Stop').at(-1);
  test('S2', '终态裁决落 learning-log（terminal_conflict_ids）',
    (stopLog.terminal_conflict_ids ?? []).includes('demo:REQ-001'), `terminal_conflict_ids=${JSON.stringify(stopLog.terminal_conflict_ids)}`);

  spawnSync('git', ['-C', root, 'checkout', '--', GUARD_FILE]); // 撤销违规
  recall('t2', `再次检查 ${GUARD_FILE} 的错误重复弹出问题`);
  const allowed = finalize('t2');
  test('S3', '撤销违规后 → Stop 放行（终态无冲突不误拦）',
    JSON.parse(allowed.stdout).decision === undefined, `decision=${JSON.parse(allowed.stdout).decision}`);
  rmSync(root, { recursive: true, force: true });

  // 无断言：删守卫不硬拦（空话条款不是存款）
  const rootSoft = join(tmpdir(), `reqbank-p1-soft-${Date.now().toString(36)}`);
  buildRoot(rootSoft, REQ_MD.replace(/\n## 断言[\s\S]*$/, '\n'));
  mkdirSync(join(rootSoft, 'src', 'demo'), { recursive: true });
  writeFileSync(join(rootSoft, GUARD_FILE), ['export const handle = (error) => {', ...GUARD_LINES, '};', ''].join('\n'));
  gitAt(rootSoft, ['init', '-q']);
  gitAt(rootSoft, ['config', 'user.email', 'eval@reqbank']);
  gitAt(rootSoft, ['config', 'user.name', 'reqbank-eval']);
  gitAt(rootSoft, ['add', '.']);
  gitAt(rootSoft, ['commit', '-qm', 'init guard']);
  spawnAt(rootSoft, join(ENGINE, 'recall.mjs'), [], {
    input: JSON.stringify({ cwd: rootSoft, session_id: 'p1-eval', turn_id: 't-soft', prompt: `修复 ${GUARD_FILE} 的错误重复弹出问题` })
  });
  writeFileSync(join(rootSoft, GUARD_FILE), ['export const handle = (error) => {', '  notifyAlways(error);', '};', ''].join('\n'));
  const softStop = spawnAt(rootSoft, join(ENGINE, 'finalize.mjs'), [], {
    input: JSON.stringify({ cwd: rootSoft, session_id: 'p1-eval', turn_id: 't-soft' })
  });
  test('S-SOFT', '无断言条款删守卫 → Stop 不硬拦（不算存款）',
    JSON.parse(softStop.stdout).decision === undefined, `decision=${JSON.parse(softStop.stdout).decision}`);
  rmSync(rootSoft, { recursive: true, force: true });
}

// ══ ③④ 分层注入 + 预算协议（直接测 formatRecallContext 纯函数 + recall 钩子）═══
{
  const record = (id, clarification, extra = {}) => ({
    scope: 'demo', id, tags: ['error-feedback'], title: `条款${id}`,
    clarification, file: 'demo/requirements.md', relatedTests: [], given: [], when: [], expect: [], verify: [],
    assertions: extra.assertions ?? []
  });
  const { formatRecallContext, RECALL_OUTPUT_CAP } = await import(join(ENGINE, 'lib', 'critic-prompt.mjs'));

  const mixed = formatRecallContext([
    record('REQ-001', '已处理错误必须直接跳过，不得再次弹出。', { assertions: [{ kind: 'no-delete', pattern: 'isMessageHandledError' }] }),
    record('REQ-002', '成功回执走成功通路组件展示。')
  ]);
  test('L0', '分层注入：禁止类正文直注 + ID 索引分层 + header 首行 + meter 末行',
    mixed.split('\n')[0].startsWith('<!-- reqbank recall:') && mixed.includes('禁止类条款') && mixed.includes('不得再次弹出')
    && mixed.includes('demo:REQ-002') && mixed.trimEnd().endsWith('-->') && mixed.includes('meter'),
    `首行=${mixed.split('\n')[0].slice(0, 30)}…`);

  const bigRecords = Array.from({ length: 60 }, (_, i) =>
    record(`REQ-${String(i + 1).padStart(3, '0')}`, `条款正文${'细节说明'.repeat(120)}${i}`));
  const capped = formatRecallContext(bigRecords, { cap: 1500, prohibitLimit: 0 });
  const meterMatch = capped.match(/meter: 注入 (\d+)\/(\d+) 条，(\d+) chars，预算 (\d+)(?:，整条省略：(.+))?/);
  test('CAP', '预算协议：超限按整条省略且 meter 如实报告',
    capped.length <= 1500 && meterMatch && Number(meterMatch[1]) < 60 && (meterMatch[5] ?? '').includes('REQ-'),
    meterMatch ? `注入 ${meterMatch[1]}/60 条，省略 ${(meterMatch[5] ?? '').split(',').length} 条` : 'meter 缺失');

  const again = formatRecallContext(bigRecords, { cap: 1500, prohibitLimit: 0 });
  test('CAP-CS', '截断路径同样 cache-stable（同输入逐字节一致）', capped === again);
  test('CAP-CONST', 'RECALL_OUTPUT_CAP 公开常量 = 10000', RECALL_OUTPUT_CAP === 10000);

  // recall 钩子端到端：L0 正文进入 additionalContext
  const root = join(tmpdir(), `reqbank-p1-inject-${Date.now().toString(36)}`);
  buildRoot(root);
  const hook = spawnAt(root, join(ENGINE, 'recall.mjs'), [], {
    input: JSON.stringify({ cwd: root, session_id: 'p1', turn_id: 't-inject', prompt: `修复 ${GUARD_FILE} 的错误重复弹出问题` })
  });
  const context = JSON.parse(hook.stdout).hookSpecificOutput?.additionalContext ?? '';
  test('INJ', 'recall 钩子端到端：禁止类正文直注进入 additionalContext',
    context.includes('禁止类条款') && context.includes('守卫缺失会让同一错误重复弹出') && context.includes('demo:REQ-002') && context.includes('meter'),
    `context ${context.length} chars`);
  rmSync(root, { recursive: true, force: true });
}

// ══ ⑤ critic req-only + 模块配额 + 召回配置（bpms 真实 fixture）═════════
{
  const patchOf = (file, minus, plus) => [
    '*** Begin Patch', `*** Update File: ${file}`, '@@',
    ...minus.map((line) => `-${line}`), ...plus.map((line) => `+${line}`), '*** End Patch'
  ].join('\n');
  // bpms 夹具用例（RO/RO-CONF/QUOTA）：本地无 bpms/frontend 真源时跳过（CI 环境）
  const bpmsAvailable = existsSync(join(BPMS, '.agentdoc', 'harness', 'modules', 'request'));
  if (!bpmsAvailable) {
    console.log('⏭ [⑤] 跳过 bpms 夹具用例（RO/RO-CONF/QUOTA）——本地无 bpms/frontend 真源');
  } else {
  const criticRun = (turnId, diff) => spawnAt(BPMS, join(BPMS, '.harness', 'engine', 'critic.mjs'), [], {
    input: JSON.stringify({ tool_name: 'apply_patch', tool_input: { command: diff }, cwd: BPMS, session_id: 'p1-eval', turn_id: turnId })
  });
  const lastCritic = (turnId) => readFileSync(join(BPMS, '.agentdoc', 'harness', 'learning-log.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter((e) => e.event === 'PostToolUse' && e.turn_id === turnId).at(-1);

  const conflictDiff = patchOf('src/shared/request/agent.ts', [
    '  if (isMessageHandledError(error)) return;',
    '  // 守卫缺失会让同一错误重复弹出',
    '  throw toRequestError(error);'
  ], ['  notifyAlways(error);']);
  const turnC1 = `p1c1-${Date.now().toString(36)}`;
  criticRun(turnC1, conflictDiff);
  const rec1 = lastCritic(turnC1);
  test('RO', 'critic 召回 req-only：recall_ids 不含 TC（去污染）',
    (rec1.recall_ids ?? []).length > 0 && (rec1.recall_ids ?? []).every((id) => !id.includes(':TC-')),
    `recall_ids=${JSON.stringify(rec1.recall_ids)}`);
  test('RO-CONF', 'req-only 后冲突判定照常（request:REQ-006 critical）',
    rec1.critic_severity === 'critical' && rec1.conflict_ids.includes('request:REQ-006'),
    `severity=${rec1.critic_severity} conflicts=${JSON.stringify(rec1.conflict_ids)}`);

  const dualDiff = [
    '*** Begin Patch',
    '*** Update File: src/shared/request/agent.ts', '@@',
    '-  if (isMessageHandledError(error)) return;',
    '-  // 守卫缺失会让同一错误重复弹出',
    '-  throw toRequestError(error);',
    '+  notifyAlways(error);',
    '*** Update File: src/shared/i18n/index.ts', '@@',
    '-  languageChangeVersion += 1;',
    '-  const currentChangeVersion = languageChangeVersion;',
    '-  if (currentChangeVersion !== version) return false;',
    '-  await languageChangeQueue.run(task);',
    '+  applyImmediately();',
    '*** End Patch'
  ].join('\n');
  const turnC2 = `p1c2-${Date.now().toString(36)}`;
  criticRun(turnC2, dualDiff);
  const rec2 = lastCritic(turnC2);
  const byScope = {};
  for (const id of rec2.recall_ids ?? []) {
    const scope = id.split(':')[0];
    byScope[scope] = (byScope[scope] ?? 0) + 1;
  }
  test('QUOTA', '模块配额：双模块 diff 每模块 ≤2 条且两模块都在',
    (byScope.request ?? 0) <= 2 && (byScope.i18n ?? 0) <= 2 && (byScope.request ?? 0) > 0 && (byScope.i18n ?? 0) > 0,
    JSON.stringify(byScope));
  }

  // 召回配置数据化：临时真源自定义同义词组（ratio↔占比）驱动扩展召回
  const root = join(tmpdir(), `reqbank-p1-config-${Date.now().toString(36)}`);
  buildRoot(root, REQ_MD.replace('正向提示通路', '占比口径'));
  const indexPath = join(root, '.agentdoc', 'harness', 'index.md');
  writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('## 待初始化高风险模块', '## 召回配置\n\n- 同义词组: ratio,占比,百分比\n\n## 待初始化高风险模块'));
  const scopeRun = spawnAt(root, join(ENGINE, 'scope.mjs'), ['ratio 口径查询']);
  const out = scopeRun.stdout;
  test('CFG', '召回配置数据化：真源同义词组（ratio↔占比）驱动扩展召回',
    out.includes('demo:REQ-002'), out.split('\n').find((l) => l.includes('REQ-002')) ?? 'REQ-002 未召回');
  rmSync(root, { recursive: true, force: true });
}

// ── 汇总 ───────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
console.log(`\n═══ P1 回归：${results.length - failed.length}/${results.length} 通过 ═══`);
if (failed.length) {
  for (const f of failed) console.log(`  失败：${f.id}`);
  process.exit(1);
}
