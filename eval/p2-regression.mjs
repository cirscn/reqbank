#!/usr/bin/env node
// P2 回归评测：五项交付 + 0.13 执法闭合——
//   ① 条款断言层（no-delete/forbid-add/forbid-path + critic 归因 + compile-weak）
//   ② pre-critic 写前拦截（PreToolUse deny）
//   ③ gate 子命令（--staged/--base/dirty + fail-closed）+ B5/B6 修复（HARNESS_GATE / verify --all）
//   ④ init --gate（pre-commit + CI workflow + claude PreToolUse 注册 + E2E 拒提交）
//   ⑤ LLM critic 四字段输出 + 子串回验 + 磁盘缓存
//   ⑥ 空召回断言池 / 未跟踪新文件 / ignore·:warn 四层 / analysis Stop
// 用法：node eval/p2-regression.mjs

import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = join(KIT_ROOT, 'engine');
const BIN = join(KIT_ROOT, 'bin', 'harness.mjs');

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
const gitAt = (root, args, extraEnv = {}) =>
  spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...extraEnv } });

// 断言演示真源：REQ-001 no-delete / REQ-002 forbid-add / REQ-003 forbid-path
const REQ_WITH_ASSERTIONS = `## 索引

REQ-001 | guard-a,guard-b | TC-001 | 已处理错误不得重复弹出
REQ-002 | forbid-a,forbid-b | TC-002 | 禁止 message.error 直弹
REQ-003 | vault-lock,path-guard | TC-003 | 保险库路径禁止改动

## 需求澄清

REQ-001: 全局拦截里 isMessageHandledError 命中的已处理错误必须直接 return 跳过，不得再经 toRequestError 抛出。
REQ-002: 业务失败提示必须走 showErrorFeedback，禁止使用 message.error 直接弹出。
REQ-003: src/vault/ 下的密钥与证书文件受条款保护，禁止任何改动。

## 断言

REQ-001 | no-delete | isMessageHandledError
REQ-002 | forbid-add | message.error
REQ-003 | forbid-path | src/vault/
`;
const TESTS_MD = `## 内容索引

TC-001 | guard-a | REQ-001 | 守卫验证
TC-002 | forbid-a | REQ-002 | 通路验证
TC-003 | vault-lock | REQ-003 | 路径验证

## 测试用例

TC-001: G=守卫在位 | W=触发拦截 | E=仅提示一次 | V=\`node -e "if(!require('fs').existsSync('package.json'))process.exit(1)"\`
TC-002: G=业务失败 | W=提示 | E=统一通路 | V=\`node -e "if(!require('fs').existsSync('package.json'))process.exit(1)"\`
TC-003: G=保险库 | W=改动 | E=拒绝 | V=\`node -e "if(!require('fs').existsSync('package.json'))process.exit(1)"\`
`;

const buildRoot = (root, requirementsMd = REQ_WITH_ASSERTIONS) => {
  rmSync(root, { recursive: true, force: true });
  const harnessDir = join(root, '.agentdoc', 'harness');
  cpSync(join(KIT_ROOT, 'templates', 'harness'), harnessDir, { recursive: true });
  const mod = join(harnessDir, 'modules', 'demo');
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, 'index.md'), '## 命中路径\n\n- `src/demo/` [strong] | guard-a,guard-b,forbid-a,forbid-b\n- `src/vault/` [strong] | vault-lock,path-guard\n');
  writeFileSync(join(mod, 'requirements.md'), requirementsMd);
  writeFileSync(join(mod, 'tests.md'), TESTS_MD);
  writeFileSync(join(harnessDir, 'index.md'), '# 索引\n\n## 已建模块\n\ndemo | .agentdoc/harness/modules/demo/ | demo 契约\n\n## 待初始化高风险模块\n\n（暂无）\n');
  writeFileSync(join(root, 'package.json'), '{}\n');
  rmSync(join(harnessDir, 'modules', '_template'), { recursive: true, force: true });
};

const patchOf = (file, minus, plus) => [
  '*** Begin Patch', `*** Update File: ${file}`, '@@',
  ...minus.map((line) => `-${line}`), ...plus.map((line) => `+${line}`), '*** End Patch'
].join('\n');

const criticRun = (root, turnId, diff) => spawnAt(root, join(ENGINE, 'critic.mjs'), [], {
  input: JSON.stringify({ tool_name: 'apply_patch', tool_input: { command: diff }, cwd: root, session_id: 'p2-eval', turn_id: turnId })
});
const lastLogOf = (root, event, turnId) => readFileSync(join(root, '.agentdoc', 'harness', 'learning-log.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  .filter((e) => e.event === event && (!turnId || e.turn_id === turnId)).at(-1);

// ══ ① 断言层（critic 集成）═══════════════════════════════
{
  const root = join(tmpdir(), `reqbank-p2-as-${Date.now().toString(36)}`);
  buildRoot(root);

  const turnA = 'p2a1';
  criticRun(root, turnA, patchOf('src/demo/agent.ts', ['  if (isMessageHandledError(error)) return;'], ['  passthrough();']));
  const logA = lastLogOf(root, 'PostToolUse', turnA);
  const hitA = (logA.assertion_hits ?? []).find((h) => h.kind === 'no-delete');
  test('A-ND', 'no-delete：删除守卫 token → critical + 归因（kind/pattern/line）',
    logA.critic_severity === 'critical' && hitA && hitA.pattern === 'isMessageHandledError' && logA.conflict_ids.includes('demo:REQ-001'),
    JSON.stringify(logA.assertion_hits));

  const turnNdCmt = 'p2-nd-cmt';
  criticRun(root, turnNdCmt, patchOf('src/demo/agent.ts',
    ['  if (isMessageHandledError(error)) return;'],
    ['  if (isMessageHandledError(error)) return; // keep']));
  const logNdCmt = lastLogOf(root, 'PostToolUse', turnNdCmt);
  test('ND-TRAIL-CMT', 'no-delete：同一守卫行只加行尾注释不拦',
    logNdCmt.critic_severity !== 'critical'
    && !(logNdCmt.assertion_hits ?? []).some((h) => h.kind === 'no-delete'),
    `severity=${logNdCmt.critic_severity} hits=${JSON.stringify(logNdCmt.assertion_hits)}`);

  const turnNdRw = 'p2-nd-rw';
  criticRun(root, turnNdRw, patchOf('src/demo/agent.ts',
    ['  if (isMessageHandledError(error)) return;'],
    ['  if (!isMessageHandledError(error)) return;']));
  const logNdRw = lastLogOf(root, 'PostToolUse', turnNdRw);
  test('ND-REWRITE', 'no-delete：改写含 token 的守卫行（极性变化）仍拦',
    logNdRw.critic_severity === 'critical'
    && (logNdRw.assertion_hits ?? []).some((h) => h.kind === 'no-delete' && h.pattern === 'isMessageHandledError'),
    `severity=${logNdRw.critic_severity} hits=${JSON.stringify(logNdRw.assertion_hits)}`);

  const turnNdInj = 'p2-nd-inj';
  criticRun(root, turnNdInj, patchOf('src/demo/agent.ts',
    ['  if (isMessageHandledError(error)) return;'],
    ['  if (otherGuard(error)) return;']));
  const logNdInj = lastLogOf(root, 'PostToolUse', turnNdInj);
  test('ND-INJECT', 'no-delete：token 换成别的标识符仍拦',
    logNdInj.critic_severity === 'critical'
    && (logNdInj.assertion_hits ?? []).some((h) => h.kind === 'no-delete'),
    `severity=${logNdInj.critic_severity}`);

  const turnB = 'p2a2';
  criticRun(root, turnB, patchOf('src/demo/agent.ts', [], ["  message.error('boom');"]));
  const logB = lastLogOf(root, 'PostToolUse', turnB);
  test('A-FA', 'forbid-add：纯新增实施禁止行为 → 确定性 critical（零 LLM）',
    logB.critic_severity === 'critical' && (logB.assertion_hits ?? []).some((h) => h.kind === 'forbid-add' && h.id === 'demo:REQ-002'),
    JSON.stringify(logB.conflict_ids));

  const turnC = 'p2a3';
  criticRun(root, turnC, patchOf('src/vault/secrets.ts', ['  old-secret-line'], ['  new-secret-line']));
  const logC = lastLogOf(root, 'PostToolUse', turnC);
  test('A-FP', 'forbid-path：受保护路径改动 → critical',
    logC.critic_severity === 'critical' && (logC.assertion_hits ?? []).some((h) => h.kind === 'forbid-path' && h.id === 'demo:REQ-003'),
    JSON.stringify(logC.conflict_ids));

  const turnD = 'p2a4';
  criticRun(root, turnD, patchOf('src/demo/agent.ts', [], ['  const totallyUnrelated = true;']));
  const logD = lastLogOf(root, 'PostToolUse', turnD);
  test('A-NEG', '无断言命中的合规 diff 不误拦',
    logD.critic_severity !== 'critical' && (logD.assertion_hits ?? []).length === 0,
    `severity=${logD.critic_severity}`);

  // compile-weak：无断言的禁止条款提示；有断言后消失
  buildRoot(root, REQ_WITH_ASSERTIONS.split('## 断言')[0]);
  const weak = spawnAt(root, BIN, ['check']);
  test('A-CW', 'compile-weak：禁止条款无断言 → 提示（不阻断）',
    weak.status === 0 && /compile-weak.*REQ-001/.test(`${weak.stdout}${weak.stderr}`), `exit=${weak.status}`);
  criticRun(root, 'p2-ngram', patchOf('src/demo/agent.ts', ['  if (isMessageHandledError(error)) return;'], ['  passthrough();']));
  const logN = lastLogOf(root, 'PostToolUse', 'p2-ngram');
  test('A-NGRAM-SOFT', '无断言的禁止条款：n-gram 不升 critical（不算存款）',
    logN.critic_severity !== 'critical' && (logN.conflict_ids ?? []).length === 0
    && (logN.assertion_hits ?? []).length === 0,
    `severity=${logN.critic_severity} conflicts=${JSON.stringify(logN.conflict_ids)}`);
  rmSync(root, { recursive: true, force: true });
}

// ══ ② pre-critic 写前拦截 ═══════════════════════════════
{
  const root = join(tmpdir(), `reqbank-p2-pre-${Date.now().toString(36)}`);
  buildRoot(root);
  const preRun = (payload) => spawnAt(root, join(ENGINE, 'pre-critic.mjs'), [], { input: JSON.stringify(payload) });

  const denied = preRun({
    session_id: 'p2', turn_id: 'p2-pre-1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Edit',
    tool_input: { file_path: join(root, 'src/demo/agent.ts'), old_string: '  if (isMessageHandledError(error)) return;', new_string: '  passthrough();', replace_all: false }
  });
  const deniedOut = JSON.parse(denied.stdout);
  test('PRE-DENY', 'PreToolUse 删守卫 → permissionDecision deny + 条款归因',
    deniedOut.hookSpecificOutput?.permissionDecision === 'deny'
    && String(deniedOut.hookSpecificOutput.permissionDecisionReason).includes('demo:REQ-001')
    && String(deniedOut.hookSpecificOutput.permissionDecisionReason).includes('no-delete'),
    deniedOut.hookSpecificOutput?.permissionDecision);
  test('PRE-LOG', '写前拦截落日志（gate_mode hard-block / denied）',
    lastLogOf(root, 'PreToolUse', 'p2-pre-1')?.denied === true);

  const writeDenied = preRun({
    session_id: 'p2', turn_id: 'p2-pre-2', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Write',
    tool_input: { file_path: join(root, 'src/demo/notify.ts'), content: "import { message } from 'antd';\nmessage.error('direct');\n" }
  });
  test('PRE-WRITE', 'Write 新建文件 forbid-add → deny',
    JSON.parse(writeDenied.stdout).hookSpecificOutput?.permissionDecision === 'deny');

  const pass = preRun({
    session_id: 'p2', turn_id: 'p2-pre-3', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Edit',
    tool_input: { file_path: join(root, 'src/demo/agent.ts'), old_string: '  const a = 1;', new_string: '  const a = 2;', replace_all: false }
  });
  test('PRE-PASS', '合规编辑 → 空 JSON 放行（快路径）',
    pass.stdout.trim() === '{}' && lastLogOf(root, 'PreToolUse', 'p2-pre-3')?.denied === false);
  rmSync(root, { recursive: true, force: true });
}

// ══ ②b 台账/文档自匹配修复 ══════════════════════════════
{
  const root = join(tmpdir(), `reqbank-p2-ledger-${Date.now().toString(36)}`);
  buildRoot(root);

  // 台账新增断言定义行：pattern 必然出现在定义行里——docs-only 编辑不再「守卫定义命中自己」
  const turnL1 = 'p2-ledger-1';
  criticRun(root, turnL1, patchOf('.agentdoc/harness/modules/demo/requirements.md',
    ['REQ-003 | forbid-path | src/vault/'],
    ['REQ-003 | forbid-path | src/vault/', 'REQ-004 | forbid-add | message.error']));
  const logL1 = lastLogOf(root, 'PostToolUse', turnL1);
  test('LEDGER-FA-SKIP', '台账新增断言定义行（含 pattern）→ 不自匹配误拦',
    (logL1.assertion_hits ?? []).length === 0 && (logL1.conflict_ids ?? []).length === 0,
    `hits=${JSON.stringify(logL1.assertion_hits)} conflicts=${JSON.stringify(logL1.conflict_ids)}`);

  // tests.md 新增 TC 行（V 命令引用 pattern）→ 同样跳过
  const turnL2 = 'p2-ledger-2';
  criticRun(root, turnL2, patchOf('.agentdoc/harness/modules/demo/tests.md',
    ['TC-003: G=保险库 | W=改动 | E=拒绝 | V=`node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"`'],
    ['TC-003: G=保险库 | W=改动 | E=拒绝 | V=`node -e "if(!require(\'fs\').existsSync(\'package.json\'))process.exit(1)"`',
      'TC-004: G=通路 | W=提示 | E=统一出口 | V=`grep -c "message.error" src/demo/agent.ts`']));
  const logL2 = lastLogOf(root, 'PostToolUse', turnL2);
  test('LEDGER-TC-SKIP', 'tests.md 新增 TC 守卫命令（含 pattern）→ 不误拦',
    (logL2.assertion_hits ?? []).length === 0,
    `hits=${JSON.stringify(logL2.assertion_hits)}`);

  // 台账删守卫断言行：no-delete 保持有效（防悄悄退役条款；docs-skip 只豁免新增行扫描）
  const turnL3 = 'p2-ledger-3';
  criticRun(root, turnL3, patchOf('.agentdoc/harness/modules/demo/requirements.md',
    ['REQ-001 | no-delete | isMessageHandledError'], []));
  const logL3 = lastLogOf(root, 'PostToolUse', turnL3);
  test('LEDGER-ND-KEPT', '台账删除守卫断言行 → no-delete 仍拦',
    logL3.critic_severity === 'critical' && (logL3.assertion_hits ?? []).some((h) => h.kind === 'no-delete'),
    `severity=${logL3.critic_severity} hits=${JSON.stringify(logL3.assertion_hits)}`);

  rmSync(root, { recursive: true, force: true });
}

// ══ ③ gate + B5/B6 修复 ═════════════════════════════════
{
  const root = join(tmpdir(), `reqbank-p2-gate-${Date.now().toString(36)}`);
  buildRoot(root);
  mkdirSync(join(root, 'src', 'demo'), { recursive: true });
  writeFileSync(join(root, 'src/demo/agent.ts'), ['export const handle = (error) => {', '  if (isMessageHandledError(error)) return;', '};', ''].join('\n'));
  gitAt(root, ['init', '-q']);
  gitAt(root, ['config', 'user.email', 'eval@reqbank']);
  gitAt(root, ['config', 'user.name', 'reqbank-eval']);
  gitAt(root, ['add', '.']);
  gitAt(root, ['commit', '-qm', 'init']);

  const gate = (args, extraEnv = {}) => spawnAt(root, BIN, ['gate', ...args], { extraEnv });

  const clean = gate([]);
  test('G-CLEAN', '干净工作区 gate 通过（exit 0）', clean.status === 0, clean.stdout.trim().slice(0, 80));

  writeFileSync(join(root, 'src/demo/agent.ts'), ['export const handle = (error) => {', '  passthrough();', '};', ''].join('\n'));
  gitAt(root, ['add', 'src/demo/agent.ts']);
  const staged = gate(['--staged']);
  test('G-STAGED', 'staged 删守卫 → gate exit 1 并指明条款',
    staged.status === 1 && `${staged.stdout}${staged.stderr}`.includes('demo:REQ-001'),
    `${staged.stdout}${staged.stderr}`.split('\n').find((l) => l.includes('REQ-001')) ?? '');
  const based = gate(['--base', 'HEAD']);
  test('G-BASE', 'gate --base HEAD 同样拦截（CI 形状）', based.status === 1);
  const gatedJson = gate(['--staged', '--json']);
  test('G-JSON', 'gate --json 结构化输出（conflicts 含 source 归因）',
    JSON.parse(gatedJson.stdout).conflicts?.[0]?.id === 'demo:REQ-001');

  gitAt(root, ['checkout', '--', 'src/demo/agent.ts']);
  const verifyAll = spawnAt(root, BIN, ['verify', '--all']);
  test('G-VALL', 'verify --all 全库枚举执行（不依赖 learning-log，B6）',
    verifyAll.status === 0 && /待执行 [1-9]/.test(verifyAll.stdout), verifyAll.stdout.split('\n')[0]);

  // B5：让引擎真崩溃（readFileSync 读到目录）——默认 fail-open / HARNESS_GATE=1 fail-closed / gate 恒 fail-closed
  // verify 只加载 tests.md，gate 加载 requirements.md——两个都换成目录
  for (const name of ['requirements.md', 'tests.md']) {
    rmSync(join(root, '.agentdoc', 'harness', 'global', name));
    mkdirSync(join(root, '.agentdoc', 'harness', 'global', name), { recursive: true });
  }
  const crashOpen = spawnAt(root, BIN, ['verify', '--tc', 'demo:TC-001']);
  const crashClosed = spawnAt(root, BIN, ['verify', '--tc', 'demo:TC-001'], { extraEnv: { HARNESS_GATE: '1' } });
  const gateCrash = spawnAt(root, BIN, ['gate', '--staged']);
  test('G-FC', 'B5 修复：崩溃默认 exit 0（fail-open）/ HARNESS_GATE=1 exit 2 / gate 恒 exit 2',
    crashOpen.status === 0 && crashClosed.status === 2 && gateCrash.status === 2,
    `verify=${crashOpen.status}/${crashClosed.status} gate=${gateCrash.status}`);
  rmSync(root, { recursive: true, force: true });
}

// ══ ④ init --gate（pre-commit + workflow + PreToolUse 注册 + E2E 拒提交）═══
{
  const root = join(tmpdir(), `reqbank-p2-init-${Date.now().toString(36)}`);
  mkdirSync(join(root, 'src', 'demo'), { recursive: true });
  writeFileSync(join(root, 'src', 'demo', 'agent.ts'), 'export const handle = (error) => {\n  if (isMessageHandledError(error)) return;\n};\n');
  gitAt(root, ['init', '-q']);
  gitAt(root, ['config', 'user.email', 'eval@reqbank']);
  gitAt(root, ['config', 'user.name', 'reqbank-eval']);
  const initRun = spawnAt(root, BIN, ['init', '--agents', 'claude', '--gate']);
  const preCommit = join(root, '.git', 'hooks', 'pre-commit');
  const workflow = join(root, '.github', 'workflows', 'reqbank-gate.yml');
  const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
  test('I-GATE', 'init --gate：pre-commit + workflow 落盘，claude 注册 PreToolUse',
    initRun.status === 0 && existsSync(preCommit) && existsSync(workflow) && Array.isArray(settings.hooks?.PreToolUse),
    `pre-commit=${existsSync(preCommit)} workflow=${existsSync(workflow)} PreToolUse=${Array.isArray(settings.hooks?.PreToolUse)}`);
  test('I-IDEM', '重复 init --gate 幂等（pre-commit 命令行不重复、PreToolUse 不重复）',
    spawnAt(root, BIN, ['init', '--agents', 'claude', '--gate']).status === 0
    && readFileSync(preCommit, 'utf8').split('\n').filter((l) => l.includes('gate --staged')).length === 1
    && JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse.length === 1);

  // I-PORT 可移植性（v0.15.0）：钩子命令不得含 POSIX 子命令替换——Windows 下从 cmd/PowerShell
  // 启动的 agent 会把 $(...) 空展开，node 拿到 /.harness/... → MODULE_NOT_FOUND → 钩子 exit 1（引擎零日志）。
  spawnAt(root, BIN, ['init', '--agents', 'codex']);
  const codexConfig = JSON.parse(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8'));
  const portCommands = [...JSON.stringify(settings).matchAll(/"command":\s*"([^"]+)"/g)].map((m) => m[1])
    .concat(Object.values(codexConfig.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command))));
  test('I-PORT', '钩子命令免 shell 特性（无 $( 替换、相对路径，cmd/PowerShell/bash 通吃）',
    portCommands.length >= 9 && portCommands.every((c) => !c.includes('$(') && /^node \.harness\/engine\//.test(c)),
    `n=${portCommands.length} 样例=${portCommands[0]}`);

  // I-URL Windows ESM 路径（v0.15.1）：CLI 动态 import 必须走 pathToFileURL——盘符裸路径
  // 在任何平台都会被 URL 解析成协议（Received protocol 'd:'，Windows check/version 复现）。
  const { dynamicImport } = await import(pathToFileURL(join(ENGINE, 'lib', 'repo-paths.mjs')).href);
  let fixedErr = null;
  try { await dynamicImport('D:/definitely/missing.mjs'); } catch (err) { fixedErr = err; }
  let rawErr = null;
  try { await import('D:/definitely/missing.mjs'); } catch (err) { rawErr = err; }
  test('I-URL', 'dynamicImport 经 pathToFileURL：盘符路径报 MODULE_NOT_FOUND 而非 URL 协议错误',
    typeof dynamicImport === 'function' && rawErr?.code === 'ERR_UNSUPPORTED_ESM_URL_SCHEME'
    && fixedErr?.code === 'ERR_MODULE_NOT_FOUND',
    `raw=${rawErr?.code} fixed=${fixedErr?.code}`);

  // 基线提交（守卫在位 + 断言真源入库）；随后 staged 删守卫 → pre-commit 钩子拒提交（四层执法 E2E）
  const mod = join(root, '.agentdoc', 'harness', 'modules', 'demo');
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, 'index.md'), '## 命中路径\n\n- `src/demo/` [strong] | guard-a,guard-b\n');
  writeFileSync(join(mod, 'requirements.md'), REQ_WITH_ASSERTIONS.split('\n').filter((l) => !l.startsWith('REQ-002') && !l.startsWith('REQ-003') && !l.startsWith('TC-002') && !l.startsWith('TC-003')).join('\n'));
  writeFileSync(join(mod, 'tests.md'), TESTS_MD.split('\n').filter((l) => !l.startsWith('TC-002') && !l.startsWith('TC-003')).join('\n'));
  const baseCommit = gitAt(root, ['add', '.']) && gitAt(root, ['commit', '-qm', 'base with guard']);
  test('I-BASE', '基线提交通过（新文件全新增行，无删除侧不误拦）', baseCommit.status === 0, `exit=${baseCommit.status}`);

  writeFileSync(join(root, 'src/demo/agent.ts'), 'export const handle = (error) => {\n  passthrough();\n};\n');
  gitAt(root, ['add', 'src/demo/agent.ts']);
  const commit = gitAt(root, ['commit', '-qm', 'should be blocked']);
  test('I-E2E', 'E2E：staged 删守卫 → git commit 被 pre-commit 拒绝',
    commit.status !== 0 && /reqbank gate/.test(`${commit.stdout}${commit.stderr}`),
    `commit exit=${commit.status}`);
  rmSync(root, { recursive: true, force: true });
}

// ══ ⑤ LLM critic 四字段 + 回验 + 缓存 ════════════════════
{
  const { applyLlmCritic, llmCriticConfig } = await import(join(ENGINE, 'lib', 'llm-critic.mjs'));
  const root = join(tmpdir(), `reqbank-p2-llm-${Date.now().toString(36)}`);
  buildRoot(root);
  process.env.HARNESS_PROJECT_ROOT = root; // in-process 调用需要锚定缓存目录
  const config = llmCriticConfig({ HARNESS_LLM_CRITIC: '1', OPENAI_API_KEY: 'sk-test' });
  const record = { scope: 'demo', id: 'REQ-001', title: '已处理错误不得重复弹出', clarification: 'isMessageHandledError 命中时必须直接 return，不得再次弹出同一错误。', tags: ['guard-a'], assertions: [] };
  const diff = patchOf('src/demo/agent.ts', [], ['  notifyAlways(error);  // 直接弹出不检查']);
  const baseVerdict = { severity: 'ok', covered: [record], weak: [], conflicts: [], classifications: [] };
  const candidates = [(recs) => recs.filter((r) => r.id === 'REQ-001').map((r) => ({ record: r, addedHits: 5 }))];

  let calls = 0;
  const goodFetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"violation": true, "clause_quote": "不得再次弹出同一错误", "diff_quote": "notifyAlways(error);", "next_step": "恢复 isMessageHandledError 守卫后再弹出"}' } }] }) };
  };
  const run1 = await applyLlmCritic({
    verdict: baseVerdict, recalledReqs: [record], diff,
    selectCandidates: candidates[0], config, fetchImpl: goodFetch
  });
  test('L-4F', '四字段输出：violation + 引文 + 下一步（仅审计，不升 critical）',
    run1.verdict.severity !== 'critical' && run1.llm.violations[0]?.clause_quote === '不得再次弹出同一错误'
    && run1.llm.violations[0]?.next_step?.includes('守卫'),
    `severity=${run1.verdict.severity} ${JSON.stringify(run1.llm.violations[0] ?? {}).slice(0, 120)}`);

  // 缓存：同 record+diff 第二次不再调用网络
  const run2 = await applyLlmCritic({
    verdict: baseVerdict, recalledReqs: [record], diff,
    selectCandidates: candidates[0], config, fetchImpl: goodFetch
  });
  test('L-CACHE', '缓存命中：第二次零网络调用（checked 含 cache 标记）',
    calls === 1 && run2.llm.checked.some((id) => String(id).includes('(cache)')),
    `calls=${calls} checked=${JSON.stringify(run2.llm.checked)}`);
  test('L-CACHE-FILE', '缓存文件落盘 .agentdoc/harness/cache/',
    existsSync(join(root, '.agentdoc', 'harness', 'cache')));

  // 回验：引文不是原文子串 → 判定丢弃（幻觉到不了决策路径）
  calls = 0;
  const hallucinatedFetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"violation": true, "clause_quote": "这条条款完全禁止通知", "diff_quote": "notifyAlways(error);", "next_step": "x"}' } }] }) };
  };
  const diff2 = patchOf('src/demo/agent.ts', [], ['  otherChange();']);
  const run3 = await applyLlmCritic({
    verdict: baseVerdict, recalledReqs: [record], diff: diff2,
    selectCandidates: candidates[0], config, fetchImpl: hallucinatedFetch
  });
  test('L-VERIFY', '子串回验：编造引文 → 判定丢弃（quote_rejections 计数）',
    run3.verdict.severity === 'ok' && run3.llm.violations.length === 0 && (run3.llm.quote_rejections ?? 0) === 1,
    `severity=${run3.verdict.severity} rejections=${run3.llm.quote_rejections}`);
  rmSync(root, { recursive: true, force: true });
}

// ══ ⑥ 0.13 执法闭合：空召回断言池 / 未跟踪新文件 / ignore·:warn 四层 / analysis Stop ══
{
  const root = join(tmpdir(), `reqbank-p2-e13-${Date.now().toString(36)}`);
  buildRoot(root);
  mkdirSync(join(root, 'src', 'demo'), { recursive: true });
  writeFileSync(join(root, 'src/demo/agent.ts'), ['export const handle = (error) => {', '  if (isMessageHandledError(error)) return;', '};', ''].join('\n'));
  gitAt(root, ['init', '-q']);
  gitAt(root, ['config', 'user.email', 'eval@reqbank']);
  gitAt(root, ['config', 'user.name', 'reqbank-eval']);
  gitAt(root, ['add', '.']);
  gitAt(root, ['commit', '-qm', 'init']);

  criticRun(root, 'e13-unreg', patchOf('src/nowhere/escape.ts', ['  if (isMessageHandledError(error)) return;'], ['  bypass();']));
  const unreg = lastLogOf(root, 'PostToolUse', 'e13-unreg');
  test('UNREG-ASSERT', '未登记路径删断言 token → 断言池仍 critical',
    unreg.critic_severity === 'critical' && (unreg.assertion_hits ?? []).some((h) => h.kind === 'no-delete'),
    `severity=${unreg.critic_severity} skip=${unreg.skip_reason}`);

  criticRun(root, 'e13-skip', patchOf('README.md', [], ['# hello']));
  const unregSkip = lastLogOf(root, 'PostToolUse', 'e13-skip');
  test('UNREG-SKIP', '未登记路径且无断言命中 → 仍 skip no_strong_recall',
    unregSkip.skip_reason === 'no_strong_recall', `skip=${unregSkip.skip_reason}`);

  writeFileSync(join(root, 'src/demo/leak.ts'), "message.error('boom');\n");
  const untrackedGate = spawnAt(root, BIN, ['gate']);
  test('UNTRACKED-GATE', '未 git add 的新文件含 forbid-add → gate exit 1',
    untrackedGate.status === 1 && `${untrackedGate.stdout}${untrackedGate.stderr}`.includes('demo:REQ-002'),
    `exit=${untrackedGate.status}`);
  rmSync(join(root, 'src/demo/leak.ts'), { force: true });

  const preRun = (turnId, extra) => spawnAt(root, join(ENGINE, 'pre-critic.mjs'), [], {
    input: JSON.stringify({
      session_id: 'p2', turn_id: turnId, cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Edit',
      tool_input: extra
    })
  });
  const ignorePre = preRun('e13-pre-ign', {
    file_path: join(root, 'src/demo/agent.ts'),
    old_string: '  if (isMessageHandledError(error)) return;',
    new_string: '  passthrough(); // reqbank-ignore: demo:REQ-001',
    replace_all: false
  });
  const ignorePreLog = lastLogOf(root, 'PreToolUse', 'e13-pre-ign');
  test('IGNORE-PRE', '写前：reqbank-ignore 不 deny',
    JSON.parse(ignorePre.stdout).hookSpecificOutput?.permissionDecision !== 'deny'
    && (ignorePreLog.suppressed_inline ?? []).includes('demo:REQ-001'),
    `denied=${ignorePreLog?.denied} suppressed=${JSON.stringify(ignorePreLog?.suppressed_inline)}`);

  writeFileSync(join(root, 'src/demo/agent.ts'), [
    'export const handle = (error) => {',
    '  passthrough(); // reqbank-ignore: demo:REQ-001',
    '};',
    ''
  ].join('\n'));
  const ignoreGate = spawnAt(root, BIN, ['gate']);
  test('IGNORE-GATE', 'gate：reqbank-ignore 不 exit 1',
    ignoreGate.status === 0, `exit=${ignoreGate.status} out=${`${ignoreGate.stdout}${ignoreGate.stderr}`.slice(0, 120)}`);

  const recall = (turnId, prompt) => spawnAt(root, join(ENGINE, 'recall.mjs'), [], {
    input: JSON.stringify({ cwd: root, session_id: 'p2-eval', turn_id: turnId, prompt })
  });
  const finalize = (turnId) => spawnAt(root, join(ENGINE, 'finalize.mjs'), [], {
    input: JSON.stringify({ cwd: root, session_id: 'p2-eval', turn_id: turnId })
  });
  recall('e13-ign-stop', '修复 src/demo/agent.ts 的错误重复弹出问题');
  const ignoreStop = finalize('e13-ign-stop');
  test('IGNORE-STOP', 'Stop：reqbank-ignore 不 block',
    JSON.parse(ignoreStop.stdout).decision !== 'block',
    `decision=${JSON.parse(ignoreStop.stdout).decision}`);

  writeFileSync(join(root, 'src/demo/agent.ts'), ['export const handle = (error) => {', '  passthrough();', '};', ''].join('\n'));
  recall('e13-anal', '分析一下项目的路由架构应该怎么改');
  const analysisStop = finalize('e13-anal');
  test('ANALYSIS-STOP', '先脏盘再 analysis 召回：Stop 仍对照 HEAD 硬拦',
    JSON.parse(analysisStop.stdout).decision === 'block'
    && String(JSON.parse(analysisStop.stdout).reason || '').includes('demo:REQ-001'),
    `decision=${JSON.parse(analysisStop.stdout).decision}`);
  rmSync(root, { recursive: true, force: true });
}

{
  const root = join(tmpdir(), `reqbank-p2-warn-${Date.now().toString(36)}`);
  const REQ_WARN = REQ_WITH_ASSERTIONS.replace(
    'REQ-001 | guard-a,guard-b | TC-001 | 已处理错误不得重复弹出',
    'REQ-001 | guard-a,guard-b | TC-001 | active:confirmed:warn | 已处理错误不得重复弹出'
  );
  buildRoot(root, REQ_WARN);
  mkdirSync(join(root, 'src', 'demo'), { recursive: true });
  writeFileSync(join(root, 'src/demo/agent.ts'), ['export const handle = (error) => {', '  if (isMessageHandledError(error)) return;', '};', ''].join('\n'));
  gitAt(root, ['init', '-q']);
  gitAt(root, ['config', 'user.email', 'eval@reqbank']);
  gitAt(root, ['config', 'user.name', 'reqbank-eval']);
  gitAt(root, ['add', '.']);
  gitAt(root, ['commit', '-qm', 'init']);

  const warnPre = spawnAt(root, join(ENGINE, 'pre-critic.mjs'), [], {
    input: JSON.stringify({
      session_id: 'p2', turn_id: 'e13-warn-pre', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Edit',
      tool_input: {
        file_path: join(root, 'src/demo/agent.ts'),
        old_string: '  if (isMessageHandledError(error)) return;',
        new_string: '  passthrough();',
        replace_all: false
      }
    })
  });
  const warnPreLog = lastLogOf(root, 'PreToolUse', 'e13-warn-pre');
  test('WARN-PRE', ':warn 条款写前不 deny',
    JSON.parse(warnPre.stdout).hookSpecificOutput?.permissionDecision !== 'deny'
    && (warnPreLog.warn_downgrades ?? []).includes('demo:REQ-001'),
    `denied=${warnPreLog?.denied} warns=${JSON.stringify(warnPreLog?.warn_downgrades)}`);

  writeFileSync(join(root, 'src/demo/agent.ts'), ['export const handle = (error) => {', '  passthrough();', '};', ''].join('\n'));
  const warnGate = spawnAt(root, BIN, ['gate']);
  test('WARN-GATE', ':warn 条款 gate 不 exit 1',
    warnGate.status === 0, `exit=${warnGate.status}`);
  rmSync(root, { recursive: true, force: true });
}

// ── 汇总 ───────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
console.log(`\n═══ P2 回归：${results.length - failed.length}/${results.length} 通过 ═══`);
if (failed.length) {
  for (const f of failed) console.log(`  失败：${f.id}`);
  process.exit(1);
}
