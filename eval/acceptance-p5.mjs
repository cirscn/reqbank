#!/usr/bin/env node
// P5 真实项目验收：bpms/frontend（真实 TS 代码库）+ bpms/backend（真实 Java 文件）。
// 与 eval/p5-ast.mjs（受控临时仓库）互补：这里攻击的是真实业务文件、真实守卫约定。
//   A 翻转攻击四层拦截（pre-critic deny / critic critical / gate exit 1 / Stop block）
//   B forbid-call：真实调用拦截 + 注释提及不误报 + 合法 antdMessage.error 不误报
//   C L1 布尔翻转：agent.ts 真实条件 data&&... 翻转（无断言则不硬拦）
//   D 边界存档：已知盲区的负对照（调用形操作数翻转 / 取反删除），如实记录不冒充通过
//   E Java 真实文件：backend 源码整文件解析干净度 + forbid-call 攻击
//   F 性能：gate 全库耗时 + 解析延迟
// 前置：bpms/frontend 已由 eval/seed-bpms-bank.mjs 建库 + 本脚本依赖的三条真实断言在真源。
// 用法：node eval/acceptance-p5.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = join(KIT_ROOT, 'engine');
const BIN = join(KIT_ROOT, 'bin', 'harness.mjs');
const BPMS = '/Users/aaron/Project/cirscn/bpms/frontend';
const BPMS_BACKEND = '/Users/aaron/Project/cirscn/bpms/backend';

const results = [];
const findings = []; // 边界/盲区如实存档（不算失败）
const test = (id, name, pass, evidence = '') => {
  results.push({ id, pass });
  console.log(`${pass ? '✓' : '✗'} [${id}] ${name}${evidence ? ` — ${evidence}` : ''}`);
};
const archive = (id, name, detail) => {
  findings.push({ id, name, detail });
  console.log(`○ [${id}] ${name} — ${detail}`);
};
const spawnAt = (root, command, args, { input, extraEnv = {} } = {}) =>
  spawnSync(process.execPath, [command, ...args], {
    input, cwd: root, encoding: 'utf8',
    env: { ...process.env, HARNESS_PROJECT_ROOT: root, ...extraEnv },
    maxBuffer: 32 * 1024 * 1024, timeout: 120000
  });
const gitAt = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const patchOf = (file, minus, plus) => [
  '*** Begin Patch', `*** Update File: ${file}`, '@@',
  ...minus.map((line) => `-${line}`), ...plus.map((line) => `+${line}`), '*** End Patch'
].join('\n');
const criticRun = (turn, diff) => spawnAt(BPMS, join(ENGINE, 'critic.mjs'), [], {
  input: JSON.stringify({ tool_name: 'apply_patch', tool_input: { command: diff }, cwd: BPMS, session_id: 'acc', turn_id: turn })
});
const lastLogOf = (event, turn) => readFileSync(join(BPMS, '.agentdoc', 'harness', 'learning-log.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  .filter((e) => e.event === event && (!turn || e.turn_id === turn)).at(-1);

const available = existsSync(join(BPMS, 'src')) && existsSync(join(BPMS, '.agentdoc', 'harness', 'modules', 'request'));
if (!available) {
  console.log('⏭ 跳过 P5 真实项目验收（需本地 bpms/frontend 夹具）');
  process.exit(0);
}

// 真实代码原文（攻击基线，用后还原）
const I18N_PATH = join(BPMS, 'src/shared/i18n/index.ts');
const FETCH_PATH = join(BPMS, 'src/shared/hooks/useFetch.ts');
const AGENT_PATH = join(BPMS, 'src/shared/request/agent.ts');
const I18N_ORIG = readFileSync(I18N_PATH, 'utf8');
const FETCH_ORIG = readFileSync(FETCH_PATH, 'utf8');
const AGENT_ORIG = readFileSync(AGENT_PATH, 'utf8');
const restoreAll = () => {
  writeFileSync(I18N_PATH, I18N_ORIG);
  writeFileSync(FETCH_PATH, FETCH_ORIG);
  writeFileSync(AGENT_PATH, AGENT_ORIG);
  gitAt(BPMS, ['reset', '-q', 'HEAD', '--', 'src/shared/i18n/index.ts', 'src/shared/hooks/useFetch.ts', 'src/shared/request/agent.ts']);
  gitAt(BPMS, ['checkout', '--', 'src/shared/i18n/index.ts', 'src/shared/hooks/useFetch.ts', 'src/shared/request/agent.ts']);
};

try {
  // ══ A 翻转攻击四层拦截（i18n:147 languageChanged 取反）══
  const i18nLine = '    if (options?.reload && languageChanged && typeof window !== \'undefined\') {';
  const i18nFlipped = '    if (options?.reload && !languageChanged && typeof window !== \'undefined\') {';

  // A1 PreToolUse 写前 deny（违规落盘之前）
  const pre = spawnAt(BPMS, join(ENGINE, 'pre-critic.mjs'), [], {
    input: JSON.stringify({
      session_id: 'acc', turn_id: 'acc-a1', cwd: BPMS, hook_event_name: 'PreToolUse', tool_name: 'Edit',
      tool_input: { file_path: I18N_PATH, old_string: i18nLine, new_string: i18nFlipped }
    })
  });
  const preOut = JSON.parse(pre.stdout);
  const preLog = lastLogOf('PreToolUse', 'acc-a1');
  test('ACC-PRE-DENY', 'A1 真实文件取反翻转：PreToolUse 写前 deny（no-negate languageChanged）',
    preOut.hookSpecificOutput?.permissionDecision === 'deny' && preLog?.denied === true,
    `${[].concat(preOut.hookSpecificOutput?.permissionDecisionReason ?? []).join(' ').slice(0, 70)}`);

  // A2 PostToolUse critic（假设 deny 被绕过：patch 已落盘）
  criticRun('acc-a2', patchOf('src/shared/i18n/index.ts', [i18nLine], [i18nFlipped]));
  const a2 = lastLogOf('PostToolUse', 'acc-a2');
  test('ACC-CRITIC', 'A2 同一翻转经 PostToolUse critic：critical + 断言归因',
    a2.critic_severity === 'critical'
    && (a2.assertion_hits ?? []).some((h) => h.kind === 'no-negate' && h.pattern === 'languageChanged')
    && (a2.conflict_ids ?? []).includes('i18n:REQ-002'),
    `severity=${a2.critic_severity} hits=${JSON.stringify((a2.assertion_hits ?? []).map((h) => `${h.kind}${h.ast === true ? '@ast' : h.ast === false ? '@str' : ''}`))}（残缺片段按设计回退字符串层）`);

  // A3 gate：真实文件落盘 + staged → exit 1
  writeFileSync(I18N_PATH, I18N_ORIG.replace(i18nLine, i18nFlipped));
  gitAt(BPMS, ['add', 'src/shared/i18n/index.ts']);
  const gateRun = spawnAt(BPMS, BIN, ['gate', '--staged']);
  test('ACC-GATE', 'A3 同一翻转 staged 提交：gate exit 1 并引用 i18n:REQ-002',
    gateRun.status === 1 && `${gateRun.stdout}${gateRun.stderr}`.includes('i18n:REQ-002'),
    `exit=${gateRun.status}`);
  restoreAll();

  // A4 Stop 终态：真实攻击时序 = prompt（记 baseline）→ 编辑落盘 → 收尾裁决
  spawnAt(BPMS, join(ENGINE, 'recall.mjs'), [], {
    input: JSON.stringify({ prompt: '重构 i18n 语言切换逻辑', cwd: BPMS, session_id: 'acc', turn_id: 'acc-a4' })
  });
  writeFileSync(I18N_PATH, I18N_ORIG.replace(i18nLine, i18nFlipped));
  const stopRun = spawnAt(BPMS, join(ENGINE, 'finalize.mjs'), [], {
    input: JSON.stringify({ turn_id: 'acc-a4', cwd: BPMS, session_id: 'acc' })
  });
  test('ACC-STOP', 'A4 同一翻转终态收尾：Stop decision=block',
    JSON.parse(stopRun.stdout).decision === 'block',
    `decision=${JSON.parse(stopRun.stdout).decision}`);
  restoreAll();

  // ══ B forbid-call：真实调用 vs 注释提及 vs 合法别名 ══
  // B1 攻击：useFetch.ts onError 里直弹 message.error（REQ-005 禁止项）
  const fetchOnErr = '      if (showErrorMessage !== false && !isMessageHandledError(error) && !isCanceledRequestError(error)) {';
  criticRun('acc-b1', patchOf('src/shared/hooks/useFetch.ts',
    [fetchOnErr],
    [fetchOnErr, '        message.error(\'加载失败\');']));
  const b1 = lastLogOf('PostToolUse', 'acc-b1');
  test('ACC-CALL', 'B1 真实 forbid-call（跨模块）：useFetch 新增 message.error 直弹被拦并归因 request:REQ-005',
    b1.critic_severity === 'critical'
    && (b1.assertion_hits ?? []).some((h) => h.kind === 'forbid-call' && h.pattern === 'message.error')
    && (b1.conflict_ids ?? []).includes('request:REQ-005'),
    `severity=${b1.critic_severity} conflicts=${JSON.stringify(b1.conflict_ids)}`);

  // B2 注释提及：不误报
  criticRun('acc-b2', patchOf('src/shared/hooks/useFetch.ts',
    ['      // 处理错误提示'],
    ['      // 处理错误提示（遗留的 message.error(msg) 写法已在 v2 移除）']));
  const b2 = lastLogOf('PostToolUse', 'acc-b2');
  test('ACC-MENTION', 'B2 真实注释提及 message.error：不误报（干净解析推翻预筛）',
    b2.critic_severity !== 'critical' && !(b2.assertion_hits ?? []).some((h) => h.kind === 'forbid-call'),
    `severity=${b2.critic_severity}`);

  // B3 合法路径对照：重写 onError 但保留 antdMessage.error 官方通道 → 不误报
  criticRun('acc-b3', patchOf('src/shared/hooks/useFetch.ts',
    ['          antdMessage.error(msg, 3);'],
    ['          antdMessage.error(msg, 3); // 官方通道：走 antd 动态导入']));
  const b3 = lastLogOf('PostToolUse', 'acc-b3');
  test('ACC-ALIAS', 'B3 合法 antdMessage.error 通道改注释：不误报（成员名边界不命中 message.error）',
    b3.critic_severity !== 'critical' && !(b3.assertion_hits ?? []).some((h) => h.kind === 'forbid-call'),
    `severity=${b3.critic_severity}`);

  // ══ C L1 布尔翻转：无断言加持的真实条件（agent.ts:44 data → !data）══
  const agentLine = '  if (data && typeof data === \'object\' && typeof data.code !== \'undefined\') {';
  criticRun('acc-c1', patchOf('src/shared/request/agent.ts',
    [agentLine],
    ['  if (!data && typeof data === \'object\' && typeof data.code !== \'undefined\') {']));
  const c1 = lastLogOf('PostToolUse', 'acc-c1');
  test('ACC-L1-FLIP', 'C1 真实条件翻转（data → !data）：无断言则不硬拦',
    c1.critic_severity !== 'critical' && (c1.conflict_ids ?? []).length === 0,
    `severity=${c1.critic_severity} conflicts=${JSON.stringify(c1.conflict_ids)}`);

  // ══ D 已知边界：负对照如实存档 ══
  // D1 调用形操作数的取反翻转（isCanceledRequestError）：L1 三元组要求操作数直接毗邻操作符，
  //    调用括号阻断匹配 → 标点层看不见；由断言层兜底（REQ-006 no-delete 守卫行被删即拦，池化全库生效）
  criticRun('acc-d1', patchOf('src/shared/hooks/useFetch.ts',
    [fetchOnErr],
    ['      if (showErrorMessage !== false && !isMessageHandledError(error) && isCanceledRequestError(error)) {']));
  const d1 = lastLogOf('PostToolUse', 'acc-d1');
  test('ACC-EDGE-CALLOPERAND', 'D1 调用形操作数翻转（!fn() → fn()）：断言层 no-delete 兜底拦截（L1 标点层盲区）',
    d1.critic_severity === 'critical'
    && (d1.assertion_hits ?? []).some((h) => h.kind === 'no-delete' && h.pattern === 'isMessageHandledError'),
    `severity=${d1.critic_severity} hits=${JSON.stringify((d1.assertion_hits ?? []).map((h) => h.kind))}`);

  // D2 取反删除（NotificationCenter !isMessageHandledError → isMessageHandledError）：
  //    no-negate 只看新增行含 !，删除取反不在其域；守卫行整行被删由 no-delete 断言兜底
  const ncLine = readFileSync(join(BPMS, 'src/apps/portal/components/NotificationCenter.tsx'), 'utf8')
    .split('\n').find((l) => l.includes('!isMessageHandledError'));
  criticRun('acc-d2', patchOf('src/apps/portal/components/NotificationCenter.tsx', [ncLine], [ncLine.replace('!', '')]));
  const d2 = lastLogOf('PostToolUse', 'acc-d2');
  test('ACC-EDGE-NEGREMOVAL', 'D2 取反删除（!fn() → fn()）：守卫行删除被 no-delete 兜底拦截',
    d2.critic_severity === 'critical'
    && (d2.assertion_hits ?? []).some((h) => h.kind === 'no-delete' && h.pattern === 'isMessageHandledError'),
    `severity=${d2.critic_severity} hits=${JSON.stringify((d2.assertion_hits ?? []).map((h) => h.kind))}`);

  // ══ E Java：backend 真实源码 ══
  if (existsSync(BPMS_BACKEND)) {
    // 找一个最大的真实 Java 文件做整文件解析干净度检验
    const find = spawnSync('find', [join(BPMS_BACKEND, 'src'), '-name', '*.java', '-size', '+5k'], { encoding: 'utf8' });
    const javaFiles = (find.stdout ?? '').split('\n').filter(Boolean);
    if (javaFiles.length) {
      const ast = await import(join(ENGINE, 'lib', 'ast.mjs'));
      let cleanCount = 0;
      const sample = javaFiles.slice(0, 20);
      for (const file of sample) {
        const r = await ast.analyzeFragment({ language: 'java', code: readFileSync(file, 'utf8') });
        if (r && !r.hasError) cleanCount += 1;
      }
      test('ACC-JAVA-PARSE', 'E1 backend 真实 Java 文件整文件解析（前 20 个 >5KB 文件）无 ERROR',
        cleanCount === sample.length, `${cleanCount}/${sample.length} 干净`);

      // E2 forbid-call 攻击：真实文件副本 + 真实方法名
      const victim = sample[0];
      const src = readFileSync(victim, 'utf8');
      const methodMatch = src.match(/(?:public|private|protected)[\w<>\[\], ]+\s+(\w+)\s*\(/);
      const realMethod = methodMatch?.[1] ?? 'toString';
      const root = join(tmpdir(), `reqbank-acc-java-${Date.now().toString(36)}`);
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(root, '.agentdoc/harness/modules/svc'), { recursive: true });
      writeFileSync(join(root, '.agentdoc/harness/modules/svc/index.md'), '## 命中路径\n\n- `src/` [strong] | svc\n');
      writeFileSync(join(root, '.agentdoc/harness/modules/svc/requirements.md'), `## 索引\n\nREQ-001 | svc | TC-001 | ${realMethod} 调用受管控\n\n## 需求澄清\n\nREQ-001: 禁止直接调用 ${realMethod}。\n\n## 断言\n\nREQ-001 | forbid-call | ${realMethod}\n`);
      writeFileSync(join(root, '.agentdoc/harness/modules/svc/tests.md'), '## 内容索引\n\nTC-001 | svc | REQ-001 | v\n\n## 测试用例\n\nTC-001: G=x | W=y | E=z | V=`node -e "process.exit(0)"`\n');
      writeFileSync(join(root, '.agentdoc/harness/index.md'), '# i\n\n## 已建模块\n\nsvc | .agentdoc/harness/modules/svc/ | s\n\n## 待初始化高风险模块\n\n（暂无）\n');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src/Victim.java'), src);
      gitAt(root, ['init', '-q']);
      const { runAssertionReview } = await import(join(ENGINE, 'lib', 'assertions.mjs'));
      const { matchPathPattern } = await import(join(ENGINE, 'lib', 'harness-store.mjs'));
      const req = { scope: 'svc', id: 'REQ-001', tags: ['svc'], title: 'x', assertions: [{ kind: 'forbid-call', pattern: realMethod }], enforcement: 'block' };
      const hits = await runAssertionReview({
        diff: `+  // 参见 ${realMethod}(x) 的说明\n+  ${realMethod}(cmd);`,
        filePaths: ['src/Victim.java'],
        recalledReqs: [req],
        matchPathPattern
      });
      test('ACC-JAVA-CALL', `E2 真实 Java 方法 forbid-call（${realMethod}）：真调用拦截`,
        hits.length === 1, `hits=${hits.length}${hits[0]?.confirmedByAst ? '（AST 确认）' : ''}`);
      rmSync(root, { recursive: true, force: true });
    } else {
      console.log('⏭ 跳过 Java 用例（backend 无 >5KB 源文件）');
    }
  } else {
    console.log('⏭ 跳过 Java 用例（无 bpms/backend）');
  }

  // ══ F 性能 ══
  const t0 = Date.now();
  spawnAt(BPMS, BIN, ['gate']);
  const gateMs = Date.now() - t0;
  test('ACC-PERF-GATE', 'F1 干净工作区 gate 全库耗时 < 3s', gateMs < 3000, `${gateMs}ms`);
} finally {
  restoreAll();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n═══ P5 真实项目验收：${results.length - failed.length}/${results.length} 通过 ═══`);
if (findings.length) {
  console.log(`边界存档（${findings.length} 条，不计失败）：`);
  for (const f of findings) console.log(`  ○ ${f.id}: ${f.detail.slice(0, 90)}`);
}
if (failed.length) {
  for (const f of failed) console.log(`  失败：${f.id}`);
  process.exit(1);
}
