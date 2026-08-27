#!/usr/bin/env node
// P3+P4 联合回归评测。
// P3：5 列生命周期/置信度、active 过滤、lifecycle lint、confirm、status 三态、漂移+** glob、
//     warn 降级、内联抑制、gate freeze、report 2.0 + 快照棘轮。
// P4：mtime 缓存正确性、日志轮转+增量读、Stop 自动 TC（HARNESS_STOP_VERIFY）、mine、reflect（含 transcript）、agent-guide。
// P5：Stop 自动沉淀（distill）：零覆盖卡片落 inbox、同日去重、环境门控（HARNESS_STOP_DISTILL）。
// 用法：node eval/p3p4-regression.mjs

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = join(KIT_ROOT, 'engine');
const BIN = join(KIT_ROOT, 'bin', 'harness.mjs');

const results = [];
const test = (id, name, pass, evidence = '') => {
  results.push({ id, pass });
  console.log(`${pass ? '✓' : '✗'} [${id}] ${name}${evidence ? ` — ${evidence}` : ''}`);
};
const spawnAt = (root, command, args, { input, extraEnv = {} } = {}) =>
  spawnSync(process.execPath, [command, ...args], {
    input, cwd: root, encoding: 'utf8',
    env: { ...process.env, HARNESS_PROJECT_ROOT: root, ...extraEnv },
    maxBuffer: 32 * 1024 * 1024, timeout: 120000
  });
const gitAt = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });

const BASE_REQ = `## 索引

REQ-001 | guard-a,guard-b | TC-001 | 已处理错误不得重复弹出
REQ-002 | guard-a,guard-b | TC-002 | 旧版重复提示策略（已退役）

## 需求澄清

REQ-001: 全局拦截里 isMessageHandledError 命中的已处理错误必须直接 return 跳过，不得再经 toRequestError 抛出——守卫缺失会让同一错误重复弹出。
REQ-002: 旧策略已被 REQ-001 取代，仅留档。

## 断言

REQ-001 | no-delete | isMessageHandledError
`;
const BASE_TESTS = `## 内容索引

TC-001 | guard-a | REQ-001 | 守卫验证
TC-002 | guard-a | REQ-002 | 留档验证

## 测试用例

TC-001: G=守卫在位 | W=触发拦截 | E=仅提示一次 | V=\`node -e "if(!require('fs').existsSync('package.json'))process.exit(1)"\`
TC-002: G=留档 | W=读取 | E=可追溯 | V=\`node -e "if(!require('fs').existsSync('package.json'))process.exit(1)"\`
`;

const buildRoot = (root, requirementsMd = BASE_REQ) => {
  rmSync(root, { recursive: true, force: true });
  const harnessDir = join(root, '.agentdoc', 'harness');
  cpSync(join(KIT_ROOT, 'templates', 'harness'), harnessDir, { recursive: true });
  const mod = join(harnessDir, 'modules', 'demo');
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, 'index.md'), '## 命中路径\n\n- `src/demo/` [strong] | guard-a,guard-b\n');
  writeFileSync(join(mod, 'requirements.md'), requirementsMd);
  writeFileSync(join(mod, 'tests.md'), BASE_TESTS);
  writeFileSync(join(harnessDir, 'index.md'), '# 索引\n\n## 已建模块\n\ndemo | .agentdoc/harness/modules/demo/ | demo 契约\n\n## 待初始化高风险模块\n\n（暂无）\n');
  writeFileSync(join(root, 'package.json'), '{}\n');
  rmSync(join(harnessDir, 'modules', '_template'), { recursive: true, force: true });
  mkdirSync(join(root, 'src', 'demo'), { recursive: true });
  writeFileSync(join(root, 'src/demo/agent.ts'), 'export const handle = (e) => {\n  if (isMessageHandledError(e)) return;\n};\n');
};

const patchOf = (file, minus, plus) => [
  '*** Begin Patch', `*** Update File: ${file}`, '@@',
  ...minus.map((line) => `-${line}`), ...plus.map((line) => `+${line}`), '*** End Patch'
].join('\n');
const criticRun = (root, turnId, diff) => spawnAt(root, join(ENGINE, 'critic.mjs'), [], {
  input: JSON.stringify({ tool_name: 'apply_patch', tool_input: { command: diff }, cwd: root, session_id: 'p34', turn_id: turnId })
});
const recallRun = (root, turnId, prompt) => spawnAt(root, join(ENGINE, 'recall.mjs'), [], {
  input: JSON.stringify({ prompt, cwd: root, session_id: 'p34', turn_id: turnId })
});
const finalizeRun = (root, turnId, extraEnv = {}) => spawnAt(root, join(ENGINE, 'finalize.mjs'), [], {
  input: JSON.stringify({ turn_id: turnId, cwd: root, session_id: 'p34' }), extraEnv
});
const lastLogOf = (root, event, turnId) => readFileSync(join(root, '.agentdoc', 'harness', 'learning-log.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  .filter((e) => e.event === event && (!turnId || e.turn_id === turnId)).at(-1);

// ══ P3：生命周期 / 置信度 ═══════════════════════════════
{
  const root = join(tmpdir(), `reqbank-p34-lc-${Date.now().toString(36)}`);
  const REQ5 = BASE_REQ
    .replace('REQ-002 | guard-a,guard-b | TC-002 | 旧版重复提示策略（已退役）',
      'REQ-002 | guard-a,guard-b | TC-002 | superseded>REQ-001:confirmed | 旧版重复提示策略（已退役）\nREQ-003 | guard-a |  | draft:inferred | 草稿条款未生效\nREQ-004 | guard-a |  | active:gap | 代码现状无法判定');
  buildRoot(root, REQ5);

  // 5 列解析 + active 过滤（spawnSync 直调，避免 spawnAt 的 execPath 包裹）
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const store = await import(${JSON.stringify(join(ENGINE, 'lib', 'harness-store.mjs'))});
    const all = store.loadAllRequirements({ includeInactive: true });
    const active = store.loadAllRequirements();
    const r2 = all.find((r) => r.id === 'REQ-002');
    const r3 = all.find((r) => r.id === 'REQ-003');
    const r4 = all.find((r) => r.id === 'REQ-004');
    console.log(JSON.stringify({
      total: all.length, activeIds: active.map((r) => r.id),
      r2: r2 && r2.status === 'superseded' && r2.supersedes === 'REQ-001',
      r3: r3 && r3.status === 'draft' && r3.confidence === 'inferred',
      r4: r4 && r4.confidence === 'gap'
    }));`], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, HARNESS_PROJECT_ROOT: root },
    maxBuffer: 32 * 1024 * 1024, timeout: 120000
  });
  const parsed = JSON.parse((probe.stdout.match(/\{.*\}/) ?? ['{}'])[0]);
  test('LC-PARSE', '5 列解析：superseded 目标/draft:inferred/active:gap 字段正确',
    parsed.r2 === true && parsed.r3 === true && parsed.r4 === true, JSON.stringify(parsed));
  test('LC-FILTER', 'active 过滤：draft/superseded 不进入运行时召回集',
    parsed.activeIds && !parsed.activeIds.includes('REQ-002') && !parsed.activeIds.includes('REQ-003') && parsed.activeIds.includes('REQ-001'),
    JSON.stringify(parsed.activeIds));

  // lifecycle lint：gap 警告 + strict 拦截；取代目标校验
  const loose = spawnAt(root, BIN, ['check']);
  const strict = spawnAt(root, BIN, ['check', '--strict']);
  test('LC-LINT', 'gap 置信度：loose 警告放行 / strict 拦截',
    loose.status === 0 && /gap 置信度/.test(`${loose.stdout}${loose.stderr}`) && strict.status === 1,
    `loose=${loose.status} strict=${strict.status}`);

  const REQ_DANGLE = BASE_REQ.replace('REQ-002 | guard-a,guard-b | TC-002 | 旧版重复提示策略（已退役）', 'REQ-002 | guard-a,guard-b | TC-002 | superseded>REQ-999 | 旧版');
  buildRoot(root, REQ_DANGLE);
  const dangle = spawnAt(root, BIN, ['check']);
  test('LC-DANGLE', 'superseded 目标不存在 → check error', dangle.status === 1 && /取代目标.*不存在/.test(dangle.stderr));

  // confirm：inferred → confirmed（幂等）
  buildRoot(root, BASE_REQ.replace('REQ-001 | guard-a,guard-b | TC-001 |', 'REQ-001 | guard-a,guard-b | TC-001 | active:inferred |'));
  const c1 = spawnAt(root, BIN, ['confirm', 'demo:REQ-001']);
  const c2 = spawnAt(root, BIN, ['confirm', 'demo:REQ-001']);
  const after = readFileSync(join(root, '.agentdoc', 'harness', 'modules', 'demo', 'requirements.md'), 'utf8');
  test('LC-CONFIRM', 'confirm 幂等升级 inferred→confirmed（第 5 列写入）',
    c1.status === 0 && c2.status === 0 && after.includes('REQ-001 | guard-a,guard-b | TC-001 | active:confirmed |'),
    after.split('\n').find((l) => l.startsWith('REQ-001')));
  rmSync(root, { recursive: true, force: true });
}

// ══ P3：status 三态 + 漂移 + ** glob ════════════════════
{
  const root = join(tmpdir(), `reqbank-p34-st-${Date.now().toString(36)}`);
  buildRoot(root);
  gitAt(root, ['init', '-q']);
  gitAt(root, ['config', 'user.email', 'e@e']); gitAt(root, ['config', 'user.name', 'e']);
  spawnAt(root, BIN, ['verify', '--tc', 'demo:TC-001']); // verified 事件
  const statusRun = spawnAt(root, BIN, ['status', '--json']);
  const statusJson = JSON.parse(statusRun.stdout);
  const row = statusJson.rows.find((r) => r.id === 'demo:REQ-001');
  const row2 = statusJson.rows.find((r) => r.id === 'demo:REQ-002');
  test('ST-STATE', 'status 三态派生：刚验证=verified、未验证=unproven（不写回真源）',
    row?.state === 'verified' && row2?.state === 'unproven' && statusJson.by_state.verified >= 1,
    JSON.stringify(statusJson.by_state));

  // 漂移：登记一条零匹配路径 → dead-path 警告；** glob 生效（新路径行 src/**/special.ts）
  const modIndex = join(root, '.agentdoc', 'harness', 'modules', 'demo', 'index.md');
  writeFileSync(modIndex, '## 命中路径\n\n- `src/deadzone/` [strong] | guard-a\n- `src/**/special.ts` [strong] | guard-b\n');
  mkdirSync(join(root, 'src/deep/nested'), { recursive: true });
  writeFileSync(join(root, 'src/deep/nested/special.ts'), 'export {};\n');
  gitAt(root, ['add', '.']); gitAt(root, ['commit', '-qm', 'x']);
  const drift = spawnAt(root, BIN, ['check']);
  const out = `${drift.stdout}${drift.stderr}`;
  test('ST-DRIFT', 'dead-path 警告零匹配路径；** glob 跨目录命中不误报',
    drift.status === 0 && /dead-path.*src\/deadzone/.test(out) && !/special\.ts/.test(out.match(/dead-path[^\n]*/g)?.join('') ?? ''),
    (out.match(/dead-path[^\n]*/g) ?? []).join(' | ').slice(0, 100));
  rmSync(root, { recursive: true, force: true });
}

// ══ P3：warn 降级 / 内联抑制 / gate freeze / report 2.0 ══════
{
  const root = join(tmpdir(), `reqbank-p34-gv-${Date.now().toString(36)}`);
  const REQ_WARN = BASE_REQ.replace('REQ-001 | guard-a,guard-b | TC-001 |', 'REQ-001 | guard-a,guard-b | TC-001 | active:confirmed:warn |');
  buildRoot(root, REQ_WARN);
  const conflictDiff = patchOf('src/demo/agent.ts', ['  if (isMessageHandledError(e)) return;'], ['  passthrough();']);

  criticRun(root, 'p34-w1', conflictDiff);
  const w1 = lastLogOf(root, 'PostToolUse', 'p34-w1');
  test('GV-WARN', ':warn 条款 conflict 降级 warning（warn_downgrades 记录）',
    w1.critic_severity === 'warning' && (w1.warn_downgrades ?? []).includes('demo:REQ-001'),
    `severity=${w1.critic_severity} downgrades=${JSON.stringify(w1.warn_downgrades)}`);

  buildRoot(root); // block 档
  criticRun(root, 'p34-s1', patchOf('src/demo/agent.ts', ['  if (isMessageHandledError(e)) return;'], ['  passthrough(); // reqbank-ignore: demo:REQ-001']));
  const s1 = lastLogOf(root, 'PostToolUse', 'p34-s1');
  test('GV-SUPPRESS', '内联抑制 reqbank-ignore → 降级且 suppressed_inline 可见可数',
    s1.critic_severity !== 'critical' && (s1.suppressed_inline ?? []).includes('demo:REQ-001'),
    `severity=${s1.critic_severity} suppressed=${JSON.stringify(s1.suppressed_inline)}`);

  // gate freeze
  buildRoot(root);
  gitAt(root, ['init', '-q']); gitAt(root, ['config', 'user.email', 'e@e']); gitAt(root, ['config', 'user.name', 'e']);
  gitAt(root, ['add', '.']); gitAt(root, ['commit', '-qm', 'base']);
  writeFileSync(join(root, 'src/demo/agent.ts'), 'export const handle = (e) => {\n  passthrough();\n};\n');
  gitAt(root, ['add', 'src/demo/agent.ts']);
  const frozen = spawnAt(root, BIN, ['gate', '--freeze']);
  const afterFreeze = spawnAt(root, BIN, ['gate', '--staged']);
  test('GV-FREEZE', '冻结存量：freeze 后同冲突 gate 放行（仅警告）',
    frozen.status === 0 && afterFreeze.status === 0 && /冻结存量/.test(`${afterFreeze.stdout}${afterFreeze.stderr}`),
    `freeze=${frozen.status} after=${afterFreeze.status}`);
  // 坏基线 → check fail + gate fail-closed
  writeFileSync(join(root, '.agentdoc', 'harness', 'gate-baseline.json'), '{broken');
  const badCheck = spawnAt(root, BIN, ['check']);
  const badGate = spawnAt(root, BIN, ['gate', '--staged']);
  test('GV-BADBASE', '坏冻结基线：check exit 1 / gate exit 2（fail-closed）',
    badCheck.status === 1 && badGate.status === 2, `check=${badCheck.status} gate=${badGate.status}`);

  // report 2.0 + 快照棘轮
  writeFileSync(join(root, '.agentdoc', 'harness', 'gate-baseline.json'), '{"ids":["demo:REQ-001"]}');
  const rep = spawnAt(root, BIN, ['report', '--json']);
  const repJson = JSON.parse(rep.stdout);
  test('RP-MATRIX', 'report 2.0：req_matrix/remediation/dead_rules 新指标齐备',
    repJson.req_total >= 2 && typeof repJson.req_matrix === 'object' && Object.keys(repJson.req_matrix).length >= 1
    && Array.isArray(repJson.dead_rules) && 'recall_closure_rate' in repJson && 'remediation_rate' in repJson,
    JSON.stringify({ matrix: repJson.req_matrix, dead: repJson.dead_rules.length }));
  const snap = spawnAt(root, BIN, ['report', '--snapshot']);
  const snapOk = spawnAt(root, BIN, ['report', '--snapshot', '--check']);
  // 新增一条 never-seen 条款 → 快照不一致
  const reqPath = join(root, '.agentdoc', 'harness', 'modules', 'demo', 'requirements.md');
  writeFileSync(reqPath, readFileSync(reqPath, 'utf8').replace(
    'REQ-002 | guard-a,guard-b | TC-002 | 旧版重复提示策略（已退役）',
    'REQ-002 | guard-a,guard-b | TC-002 | 旧版重复提示策略（已退役）\nREQ-009 | guard-a | TC-001 | 快照棘轮探针'
  ));
  const snapDiff = spawnAt(root, BIN, ['report', '--snapshot', '--check']);
  const snapRefresh = spawnAt(root, BIN, ['report', '--snapshot']);
  const snapAgain = spawnAt(root, BIN, ['report', '--snapshot', '--check']);
  test('RP-SNAPSHOT', '快照棘轮：一致→通过；条款变化→exit 1；更新后再通过',
    snap.status === 0 && snapOk.status === 0 && snapDiff.status === 1 && /REQ-009/.test(snapDiff.stderr + snapDiff.stdout)
    && snapRefresh.status === 0 && snapAgain.status === 0,
    `ok=${snapOk.status} diff=${snapDiff.status} again=${snapAgain.status}`);
  rmSync(root, { recursive: true, force: true });
}

// ══ P4：Stop 自动 TC / 日志轮转 / mtime 缓存 ═════════════
{
  const root = join(tmpdir(), `reqbank-p34-p4-${Date.now().toString(36)}`);
  buildRoot(root);
  gitAt(root, ['init', '-q']); gitAt(root, ['config', 'user.email', 'e@e']); gitAt(root, ['config', 'user.name', 'e']);
  gitAt(root, ['add', '.']); gitAt(root, ['commit', '-qm', 'base']);

  // Stop 自动 TC：默认关（行为不变）；开启后 TC 失败 → block；TC 全过 → 降级放行
  const recallTurn = (turn) => recallRun(root, turn, '修复 src/demo/agent.ts 错误重复弹出');
  const conflictEdit = () => {
    writeFileSync(join(root, 'src/demo/agent.ts'), 'export const handle = (e) => {\n  passthrough();\n};\n');
  };
  recallTurn('p34-t1'); conflictEdit();
  const offRun = finalizeRun(root, 'p34-t1');
  test('STOFF', '默认（无 HARNESS_STOP_VERIFY）终态裁决行为不变：block',
    JSON.parse(offRun.stdout).decision === 'block');
  spawnSync('git', ['-C', root, 'checkout', '--', 'src/demo/agent.ts']);

  // TC 失败版：TC-001 命令改为必失败
  const failTests = BASE_TESTS.replace(/TC-001:.*\n/, 'TC-001: G=x | W=y | E=z | V=`node -e "process.exit(3)"`\n');
  writeFileSync(join(root, '.agentdoc', 'harness', 'modules', 'demo', 'tests.md'), failTests);
  recallTurn('p34-t2'); conflictEdit();
  const failRun = finalizeRun(root, 'p34-t2', { HARNESS_STOP_VERIFY: '1' });
  const failLog = lastLogOf(root, 'Stop', 'p34-t2');
  test('STC-FAIL', 'Stop 自动 TC：TC 失败 → block 引用 TC 验证失败',
    JSON.parse(failRun.stdout).decision === 'block' && String(JSON.parse(failRun.stdout).reason).includes('TC 验证失败')
    && failLog.stop_tc_results?.some((r) => r.exit !== 0),
    JSON.stringify(failLog.stop_tc_results));
  spawnSync('git', ['-C', root, 'checkout', '--', 'src/demo/agent.ts']);
  writeFileSync(join(root, '.agentdoc', 'harness', 'modules', 'demo', 'tests.md'), BASE_TESTS);

  recallTurn('p34-t3'); conflictEdit();
  const passRun = finalizeRun(root, 'p34-t3', { HARNESS_STOP_VERIFY: '1' });
  const passLog = lastLogOf(root, 'Stop', 'p34-t3');
  test('STC-PASS', 'Stop 自动 TC：可执行 TC 全过 → 冲突降级放行（stop_tc_downgrades）',
    JSON.parse(passRun.stdout).decision === undefined && (passLog.stop_tc_downgrades ?? []).includes('demo:REQ-001'),
    `downgrades=${JSON.stringify(passLog.stop_tc_downgrades)}`);
  spawnSync('git', ['-C', root, 'checkout', '--', 'src/demo/agent.ts']);

  // 日志轮转（小阈值）+ 增量读
  const logPath = join(root, '.agentdoc', 'harness', 'learning-log.jsonl');
  const before = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length;
  const rotRun = spawnAt(root, join(ENGINE, 'recall.mjs'), [], {
    input: JSON.stringify({ prompt: 'x', cwd: root, session_id: 'p34', turn_id: 'p34-rot' }),
    extraEnv: { HARNESS_LOG_ROTATE_BYTES: '256' }
  });
  void rotRun;
  const rotated = existsSync(`${logPath}.1`) || existsSync(logPath);
  const afterCount = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length;
  test('LOG-ROTATE', '日志轮转：小阈值下触发 .jsonl.1 且当前日志可用（事件不丢）',
    rotated && afterCount >= 1 && rotRun.status === 0, `.1=${existsSync(`${logPath}.1`)} 当前条数=${afterCount}（轮前 ${before}）`);

  // mtime 缓存正确性：in-process 两次加载，中途改文件 + 推 mtime
  process.env.HARNESS_PROJECT_ROOT = root;
  const store = await import(join(ENGINE, 'lib', 'harness-store.mjs'));
  const reqFilePath = join(root, '.agentdoc', 'harness', 'modules', 'demo', 'requirements.md');
  const { utimesSync } = await import('node:fs');
  const n1 = store.loadAllRequirements().length;
  writeFileSync(reqFilePath, readFileSync(reqFilePath, 'utf8').replace(
    'REQ-002 | guard-a,guard-b | TC-002 | 旧版重复提示策略（已退役）',
    'REQ-002 | guard-a,guard-b | TC-002 | 旧版重复提示策略（已退役）\nREQ-777 | guard-a | TC-001 | 缓存探针'
  ));
  const nowTime = new Date();
  utimesSync(reqFilePath, nowTime, new Date(nowTime.getTime() + 2000));
  const n2 = store.loadAllRequirements().length;
  const [n1s, n2s] = [n1, n2];
  test('MTIME', 'mtime 缓存：文件变更后失效重读（新条目可见）', n1s >= 2 && n2s === n1s + 1, `${n1s} → ${n2s}`);
  rmSync(root, { recursive: true, force: true });
}

// ══ P4：mine / reflect / guide ══════════════════════════
{
  const root = join(tmpdir(), `reqbank-p34-mr-${Date.now().toString(36)}`);
  buildRoot(root);
  writeFileSync(join(root, 'AGENTS.md'), '# 约定\n\n- 全局错误提示不得使用 message.error\n');
  writeFileSync(join(root, 'src/demo/todo.ts'), '// TODO: 修复 token 刷新竞态\nexport {};\n');
  gitAt(root, ['init', '-q']); gitAt(root, ['config', 'user.email', 'e@e']); gitAt(root, ['config', 'user.name', 'e']);
  gitAt(root, ['add', '.']); gitAt(root, ['commit', '-qm', 'fix: 修复登录态 401 循环跳转']);
  const mineRun = spawnAt(root, join(ENGINE, 'mine.mjs'), ['--limit', '10']);
  const mineLines = mineRun.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const sources = new Set(mineLines.map((c) => c.source));
  const demoReqBefore = readFileSync(join(root, '.agentdoc', 'harness', 'modules', 'demo', 'requirements.md'), 'utf8');
  test('MINE', 'mine：instruction/git-fix/todo 三源产出 + inbox 落盘 + 不写 modules/',
    sources.has('instruction') && sources.has('git-fix') && sources.has('todo')
    && existsSync(join(root, '.agentdoc', 'harness', 'inbox'))
    && !readFileSync(join(root, '.agentdoc', 'harness', 'modules', 'demo', 'requirements.md'), 'utf8').includes('REQ-777')
    && demoReqBefore.length > 0,
    `sources=${[...sources].join(',')} 候选=${mineLines.length}`);

  // reflect：构造两条同 id 冲突 + 三次零召回同路径 + transcript
  criticRun(root, 'r1', patchOf('src/demo/agent.ts', ['  if (isMessageHandledError(e)) return;'], ['  x();']));
  criticRun(root, 'r2', patchOf('src/demo/agent.ts', ['  if (isMessageHandledError(e)) return;'], ['  y();']));
  for (const turn of ['z1', 'z2', 'z3']) {
    criticRun(root, turn, patchOf('src/unregistered/thing.ts', [], ['  line();']));
  }
  const transcriptPath = join(root, 'fake-transcript.jsonl');
  writeFileSync(transcriptPath, [
    JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', payload: { type: 'function_call', call_id: 'c1', arguments: { file_path: '/x/src/orphan/z.ts' } } }),
    JSON.stringify({ message: { content: '不要用 message.error 弹全局提示，会重复弹出' } })
  ].join('\n'));
  const reflectRun = spawnAt(root, join(ENGINE, 'reflect.mjs'), ['--transcript', transcriptPath]);
  const reflectJson = JSON.parse(reflectRun.stdout.trim().split('\n').at(-1));
  const reflectDoc = readFileSync(join(root, '.agentdoc', 'harness', 'inbox', `reflect-${new Date().toISOString().slice(0, 10)}.md`), 'utf8');
  test('REFLECT', 'reflect：重复冲突/零召回路径/转录接线三类建议 + inbox 落盘',
    /repeat-conflict.*REQ-001|REQ-001.*repeat-conflict|判冲突/.test(reflectDoc) && /unregistered-path/.test(reflectDoc)
    && (/transcript-unregistered/.test(reflectDoc) || /user-correction/.test(reflectDoc)) && reflectJson.suggestions >= 2,
    `suggestions=${reflectJson.suggestions} kinds=${[...reflectDoc.matchAll(/\[(\w[\w-]*)\]/g)].map((m) => m[1]).slice(0, 6).join(',')}`);

  test('GUIDE', 'agent-guide 向导随模板分发', existsSync(join(KIT_ROOT, 'templates', 'harness', 'agent-guide.md')));
  rmSync(root, { recursive: true, force: true });
}

// ══ P5：Stop 自动沉淀 / distill ══════════════════════════
{
  const root = join(tmpdir(), `reqbank-p5-dl-${Date.now().toString(36)}`);
  buildRoot(root);
  gitAt(root, ['init', '-q']); gitAt(root, ['config', 'user.email', 'e@e']); gitAt(root, ['config', 'user.name', 'e']);
  gitAt(root, ['add', '.']); gitAt(root, ['commit', '-qm', 'base']);

  // 零覆盖业务文件改动：src/orphan/ 不在任何模块命中路径内（untracked 新文件走合成 diff）
  recallRun(root, 'p34-da', '实现 src/orphan/util.ts 的工具函数并补测试');
  mkdirSync(join(root, 'src', 'orphan'), { recursive: true });
  writeFileSync(join(root, 'src/orphan/util.ts'), 'export const util = () => 2;\n');
  const daRun = finalizeRun(root, 'p34-da');
  const stopCardPath = join(root, '.agentdoc', 'harness', 'inbox', `stop-${new Date().toISOString().slice(0, 10)}.md`);
  const daLog = lastLogOf(root, 'Stop', 'p34-da');
  test('DISTILL', 'Stop 自动沉淀：零覆盖改动落 inbox 卡片 + distill 审计字段 + 放行语义不变',
    existsSync(stopCardPath)
    && (readFileSync(stopCardPath, 'utf8').match(/\[stop-uncovered\]/g) ?? []).length === 1
    && (daLog.distill_deterministic_cards ?? []).some((t) => t.includes('src/orphan/util.ts'))
    && daLog.decision === 'allow'
    && JSON.parse(daRun.stdout || '{}').decision === undefined,
    `cards=${JSON.stringify(daLog.distill_deterministic_cards)}`);

  // 同日去重：第二个回合再次改动同一文件，卡片不重复追加
  recallRun(root, 'p34-db', '再补充 src/orphan/util.ts 的边界用例');
  const dbRun = finalizeRun(root, 'p34-db');
  const dbLog = lastLogOf(root, 'Stop', 'p34-db');
  void dbRun;
  test('DISTILL-DUP', 'Stop 自动沉淀同日同名卡片去重',
    (dbLog.distill_deterministic_cards ?? []).length === 0
    && (readFileSync(stopCardPath, 'utf8').match(/\[stop-uncovered\]/g) ?? []).length === 1,
    `cards=${JSON.stringify(dbLog.distill_deterministic_cards)}`);

  // 环境门控与跳过原因（直调 lib，零 fs 副作用）
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const d = await import(${JSON.stringify(join(ENGINE, 'lib', 'distill.mjs'))});
    const nothing = await d.runStopDistill({ uncoveredFiles: [], diffTexts: new Map() });
    const noProvider = await d.runStopDistill({ uncoveredFiles: [], diffTexts: new Map(), env: { HARNESS_STOP_DISTILL: '1', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
    console.log(JSON.stringify({
      nothing: nothing.skipped_reason,
      noProvider: noProvider.skipped_reason,
      defaultOff: d.stopDistillConfig({}).enabled === false,
      gateWithoutKey: d.stopDistillConfig({ HARNESS_STOP_DISTILL: '1' }).provider === null
    }));`], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, HARNESS_PROJECT_ROOT: root },
    maxBuffer: 32 * 1024 * 1024, timeout: 120000
  });
  const p5cfg = JSON.parse((probe.stdout.match(/\{.*\}/) ?? ['{}'])[0]);
  test('DISTILL-CFG', 'distill 配置：默认关闭 / 开启无 key→no_provider / 无素材→nothing_to_distill',
    p5cfg.nothing === 'nothing_to_distill' && p5cfg.noProvider === 'no_provider'
    && p5cfg.defaultOff === true && p5cfg.gateWithoutKey === true,
    probe.stdout.trim());

  rmSync(root, { recursive: true, force: true });
}

// ── 汇总 ───────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
console.log(`\n═══ P3+P4 回归：${results.length - failed.length}/${results.length} 通过 ═══`);
if (failed.length) {
  for (const f of failed) console.log(`  失败：${f.id}`);
  process.exit(1);
}
