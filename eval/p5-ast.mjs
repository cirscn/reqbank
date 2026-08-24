#!/usr/bin/env node
// P5 语义检测升级回归：L1 标点翻转 + L2 tree-sitter 结构化断言。
//   ① L1 单元：detectBooleanFlip 翻转/等价改写/注释豁免
//   ② L2 加载器：vendor 完整性 / 懒加载（用不到的语言不进内存）/ 六语言提取
//   ③ L2 断言：Java forbid-call（真实调用拦截、注释/字符串提及不误报）
//              TS no-negate（!x 翻转拦截）/ 无语法包语言字符串兜底
//   ④ 四层继承：pre-critic 写前 deny 结构化断言
//   ⑤ CLI：lang add/list/remove（网络依赖，离线跳过）
// 用法：node eval/p5-ast.mjs

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    maxBuffer: 32 * 1024 * 1024, timeout: 120000
  });
const gitAt = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });

// ── L1 单元：翻转检测 ─────────────────────────────────────
{
  const { detectBooleanFlip } = await import(join(ENGINE, 'lib', 'critic-prompt.mjs'));
  const diffOf = (minus, plus) => `@@\n-${minus}\n+${plus}`;
  const flip = detectBooleanFlip(diffOf('  const ok = user && active;', '  const ok = !user || active;'));
  test('L1-FLIP', '极性+连接符双重翻转检出（user&&active → !user||active）',
    flip.length === 1 && flip[0].kind === 'flip:both', JSON.stringify(flip));
  const opOnly = detectBooleanFlip(diffOf('  if (a && b) go();', '  if (a || b) go();'));
  test('L1-OP', '纯连接符翻转检出（&&→||）',
    opOnly.length === 1 && opOnly[0].kind === 'flip:operator', JSON.stringify(opOnly.map((f) => f.kind)));
  const polOnly = detectBooleanFlip(diffOf('  if (user && active) go();', '  if (user && !active) go();'));
  test('L1-POL', '单操作数极性翻转检出（active → !active）',
    polOnly.length === 1 && polOnly[0].kind === 'flip:polarity', JSON.stringify(polOnly.map((f) => f.kind)));
  const benign = detectBooleanFlip(diffOf('  const ok = user && active;', '  const ok = active && user;'));
  test('L1-BENIGN', '等价改写不误报（操作数交换 a&&b → b&&a）', benign.length === 0);
  const comment = detectBooleanFlip('@@\n-  // was: user && active\n+  // now: !user || active（注释）');
  test('L1-COMMENT', '注释行不参与翻转判定', comment.length === 0);
}

// ── L2 加载器 ─────────────────────────────────────────────
{
  const ast = await import(join(ENGINE, 'lib', 'ast.mjs'));
  test('VENDOR', 'vendor 资产完整（runtime + 7 语法包 sha256 对照 VENDOR.json）',
    ast.verifyVendorAssets().length === 0, ast.verifyVendorAssets().join(';') || 'OK');
  test('EXTMAP', '后缀映射：.ts/.java/.py/.go/.rs/.tsx 命中，.yaml/.html 无语法包（声明式留给字符串层）',
    ['src/a.ts', 'A.java', 'm.py', 'x.go', 'y.rs', 'z.tsx'].every((p) => ast.astLanguageForPath(p))
    && ast.astLanguageForPath('c.yaml') === null && ast.astLanguageForPath('x.html') === null);

  // 懒加载：只解析 java/typescript，python/go/rust/tsx/javascript 不得进内存
  ast.resetAstState();
  await ast.analyzeFragment({ language: 'java', code: 'foo();' });
  await ast.analyzeFragment({ language: 'typescript', code: 'bar();' });
  const loaded = ast.getLoadedGrammarNames();
  test('LAZY', '语法包按需懒加载：用到的才进内存',
    loaded.includes('java') && loaded.includes('typescript')
    && !loaded.includes('python') && !loaded.includes('go') && !loaded.includes('rust') && !loaded.includes('tsx'),
    `loaded=${loaded.join(',')}`);

  // 六语言结构提取快检（每语言取反+调用）
  const cases = [
    ['typescript', 'if (!isHandled(e)) { message.error(x); }', 'isHandled', ['isHandled', 'error']],
    ['javascript', 'if (!user || !active) logout();', 'user', ['logout']],
    ['java', 'if (!token.valid()) reject();', 'valid', ['valid', 'reject']],
    ['python', 'if not ok:\n    notify(x)', 'ok', ['notify']],
    ['go', 'if !c.ready() { retry() }', 'ready', ['ready', 'retry']],
    ['rust', 'if !valid { abort(); }', 'valid', ['abort']]
  ];
  let allOk = true;
  const detail = [];
  for (const [language, code, wantNeg, wantCalls] of cases) {
    const r = await ast.analyzeFragment({ language, code });
    const ok = r && r.negations.includes(wantNeg) && wantCalls.every((c) => r.calls.includes(c)) && !r.hasError;
    allOk = allOk && ok;
    detail.push(`${language}:${ok ? 'ok' : JSON.stringify(r)}`);
  }
  test('EXTRACT6', '六语言取反/调用结构提取', allOk, detail.join(' '));

  // vendor 损坏检测：篡改一个语法包 → verify 报告 → 还原 → 通过
  const grammarPath = join(ENGINE, 'vendor', 'tree-sitter', 'grammars', 'tree-sitter-java.wasm.br');
  const original = readFileSync(grammarPath);
  try {
    writeFileSync(grammarPath, Buffer.concat([original, Buffer.from('tamper')]));
    const problems = ast.verifyVendorAssets();
    test('TAMPER', 'vendor 篡改被 sha256 对照抓住', problems.some((p) => p.includes('tree-sitter-java')), problems.join(';'));
  } finally {
    writeFileSync(grammarPath, original);
  }
  test('RESTORE', '还原后 vendor 校验恢复', ast.verifyVendorAssets().length === 0);
}

// ── 受控仓库：Java + TS 结构化断言端到端 ──────────────────
{
  const root = join(tmpdir(), `reqbank-p5-${Date.now().toString(36)}`);
  rmSync(root, { recursive: true, force: true });
  const harnessDir = join(root, '.agentdoc', 'harness');
  cpSync(join(KIT_ROOT, 'templates', 'harness'), harnessDir, { recursive: true });
  const mod = join(harnessDir, 'modules', 'svc');
  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, 'index.md'), '## 命中路径\n\n- `src/svc/` [strong] | svc-tag\n');
  writeFileSync(join(mod, 'requirements.md'), `## 索引

REQ-001 | svc-tag | TC-001 | active:confirmed | 运维命令必须经审批网关
REQ-002 | svc-tag | TC-002 | active:confirmed | 已处理错误守卫不得取反

## 需求澄清

REQ-001: 危险运维调用必须走 approveFirst，禁止直接 execRuntimeCommand。
REQ-002: isHandledError 为守卫语义，取反会让守卫反向放行。

## 断言

REQ-001 | forbid-call | execRuntimeCommand
REQ-002 | no-negate | isHandledError
`);
  writeFileSync(join(mod, 'tests.md'), `## 内容索引

TC-001 | svc-tag | REQ-001 | v
TC-002 | svc-tag | REQ-002 | v

## 测试用例

TC-001: G=x | W=y | E=z | V=\`node -e "process.exit(0)"\`
TC-002: G=x | W=y | E=z | V=\`node -e "process.exit(0)"\`
`);
  writeFileSync(join(harnessDir, 'index.md'), '# i\n\n## 已建模块\n\nsvc | .agentdoc/harness/modules/svc/ | s\n\n## 待初始化高风险模块\n\n（暂无）\n');
  writeFileSync(join(root, 'package.json'), '{}');
  rmSync(join(harnessDir, 'modules', '_template'), { recursive: true, force: true });
  mkdirSync(join(root, 'src', 'svc'), { recursive: true });
  writeFileSync(join(root, 'src/svc/Ops.java'), ['class Ops {', '  void run(String cmd) {', '    approveFirst(cmd);', '  }', '}', ''].join('\n'));
  writeFileSync(join(root, 'src/svc/guard.ts'), ['export const handle = (error: unknown) => {', '  if (isHandledError(error)) return;', '};', ''].join('\n'));
  gitAt(root, ['init', '-q']);
  gitAt(root, ['config', 'user.email', 'p5@x']); gitAt(root, ['config', 'user.name', 'p5']);
  gitAt(root, ['add', '.']); gitAt(root, ['commit', '-qm', 'base']);

  const patchOf = (file, minus, plus) => [
    '*** Begin Patch', `*** Update File: ${file}`, '@@',
    ...minus.map((line) => `-${line}`), ...plus.map((line) => `+${line}`), '*** End Patch'
  ].join('\n');
  const criticRun = (turn, diff) => spawnAt(root, join(ENGINE, 'critic.mjs'), [], {
    input: JSON.stringify({ tool_name: 'apply_patch', tool_input: { command: diff }, cwd: root, session_id: 'p5', turn_id: turn })
  });
  const lastLogOf = (root2, event, turn) => readFileSync(join(root2, '.agentdoc', 'harness', 'learning-log.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter((e) => e.event === event && (!turn || e.turn_id === turn)).at(-1);

  // Java 真实调用拦截（forbid-call + AST 确认）
  criticRun('p5a', patchOf('src/svc/Ops.java',
    ['    approveFirst(cmd);'],
    ['    // 说明：execRuntimeCommand(cmd) 由审批网关触发', '    String doc = "use execRuntimeCommand(cmd) here";', '    execRuntimeCommand(cmd);']));
  const p5a = lastLogOf(root, 'PostToolUse', 'p5a');
  test('JAVA-CALL', 'Java forbid-call：真实调用点被拦截（AST 确认归因）',
    p5a.critic_severity === 'critical'
    && (p5a.assertion_hits ?? []).some((h) => h.kind === 'forbid-call' && h.pattern === 'execRuntimeCommand')
    && (p5a.conflict_ids ?? []).includes('svc:REQ-001'),
    `severity=${p5a.critic_severity} hits=${JSON.stringify((p5a.assertion_hits ?? []).map((h) => h.kind))}`);

  // Java 注释/字符串提及不误报（AST 推翻字符串预筛）
  criticRun('p5b', patchOf('src/svc/Ops.java',
    ['    approveFirst(cmd);'],
    ['    // 说明：execRuntimeCommand(cmd) 由审批网关触发', '    String doc = "use execRuntimeCommand(cmd) here";']));
  const p5b = lastLogOf(root, 'PostToolUse', 'p5b');
  test('JAVA-MENTION', 'Java 注释/字符串提及不误报（干净解析推翻预筛）',
    p5b.critic_severity !== 'critical'
    && !(p5b.assertion_hits ?? []).some((h) => h.kind === 'forbid-call'),
    `severity=${p5b.critic_severity}`);

  // TS !x 翻转拦截（no-negate）
  criticRun('p5c', patchOf('src/svc/guard.ts',
    ['  if (isHandledError(error)) return;'],
    ['  if (!isHandledError(error)) return;']));
  const p5c = lastLogOf(root, 'PostToolUse', 'p5c');
  test('TS-NEGATE', 'TS no-negate：守卫取反（!isHandledError）被拦截',
    p5c.critic_severity === 'critical'
    && (p5c.assertion_hits ?? []).some((h) => h.kind === 'no-negate')
    && (p5c.conflict_ids ?? []).includes('svc:REQ-002'),
    `severity=${p5c.critic_severity}`);

  // 无语法包语言：字符串层兜底照拦
  mkdirSync(join(root, 'src', 'legacy'), { recursive: true });
  writeFileSync(join(root, 'src/legacy/a.rb'), 'def check(token_valid)\nend\n');
  criticRun('p5d', patchOf('src/legacy/a.rb', ['def check(token_valid)'], ['def check2(x)']));
  // .rb 不在命中路径（未登记）——挂在 svc 路径下改用 java 文件名外的场景不成立；
  // 兜底语义直接用断言层单元验证：
  const { runAssertionReview } = await import(join(ENGINE, 'lib', 'assertions.mjs'));
  const { matchPathPattern } = await import(join(ENGINE, 'lib', 'harness-store.mjs'));
  const rbReq = { scope: 'svc', id: 'REQ-002', tags: ['svc-tag'], title: 'x', assertions: [{ kind: 'no-negate', pattern: 'token_valid' }], enforcement: 'block' };
  const rbHits = await runAssertionReview({
    diff: '+  if !token_valid then reject end',
    filePaths: ['src/svc/check.rb'],
    recalledReqs: [rbReq],
    matchPathPattern
  });
  test('RB-FALLBACK', '无语法包语言（.rb）no-negate 走字符串兜底照拦', rbHits.length === 1, `hits=${rbHits.length}`);

  // 四层继承：pre-critic 写前 deny（结构化断言在落盘之前拦截）
  const preRun = spawnAt(root, join(ENGINE, 'pre-critic.mjs'), [], {
    input: JSON.stringify({
      session_id: 'p5', turn_id: 'p5e', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Edit',
      tool_input: {
        file_path: join(root, 'src/svc/Ops.java'),
        old_string: '    approveFirst(cmd);',
        new_string: '    execRuntimeCommand(cmd);'
      }
    })
  });
  test('PRE-DENY', '结构化断言四层继承：PreToolUse 写前 deny（违规落盘之前）',
    JSON.parse(preRun.stdout).hookSpecificOutput?.permissionDecision === 'deny'
    && lastLogOf(root, 'PreToolUse', 'p5e').denied === true);
  rmSync(root, { recursive: true, force: true });
}

// ── CLI：lang add/list/remove（网络依赖）──────────────────
{
  const root = join(tmpdir(), `reqbank-p5lang-${Date.now().toString(36)}`);
  rmSync(root, { recursive: true, force: true });
  const harnessDir = join(root, '.agentdoc', 'harness');
  cpSync(join(KIT_ROOT, 'templates', 'harness'), harnessDir, { recursive: true });
  writeFileSync(join(harnessDir, 'index.md'), '# i\n\n## 已建模块\n\n（暂无）\n\n## 待初始化高风险模块\n\n（暂无）\n');
  writeFileSync(join(root, 'package.json'), '{}');
  gitAt(root, ['init', '-q']);

  const addRun = spawnAt(root, BIN, ['lang', 'add', 'kotlin', '--ext', '.kt,.kts']);
  if (addRun.status !== 0 && /fetch|network|ENOTFOUND|ETIMEDOUT|下载失败/i.test(`${addRun.stdout}${addRun.stderr}`)) {
    console.log('⏭ 跳过 LANG-* 用例（离线环境无法下载语法包）');
  } else {
    const grammarOk = existsSync(join(root, '.agentdoc', 'harness', 'vendor-lang', 'tree-sitter-kotlin.wasm.br'));
    const mapOk = readFileSync(join(root, '.agentdoc', 'harness', 'vendor-lang', 'lang-map.json'), 'utf8').includes('".kt": "kotlin"');
    test('LANG-ADD', 'lang add kotlin：语法包下载落盘 + 后缀映射写入',
      addRun.status === 0 && grammarOk && mapOk, `exit=${addRun.status}`);

    const ast = await import(join(ENGINE, 'lib', 'ast.mjs'));
    process.env.HARNESS_PROJECT_ROOT = root;
    ast.resetProjectLangMapCache();
    const langOf = ast.astLanguageForPath('src/Main.kt');
    const kt = await ast.analyzeFragment({ language: 'kotlin', code: 'if (!valid) { retry() }' });
    test('LANG-USE', 'lang add 后 .kt 结构化断言可用（kotlin 取反/调用提取）',
      langOf === 'kotlin' && kt?.negations.includes('valid') === true && kt?.calls.includes('retry') === true,
      `lang=${langOf} neg=${JSON.stringify(kt?.negations)} calls=${JSON.stringify(kt?.calls)}`);

    const rmRun = spawnAt(root, BIN, ['lang', 'remove', 'kotlin']);
    ast.resetProjectLangMapCache();
    test('LANG-REMOVE', 'lang remove：语法包与映射清除',
      rmRun.status === 0 && !existsSync(join(root, '.agentdoc', 'harness', 'vendor-lang', 'tree-sitter-kotlin.wasm.br'))
      && ast.astLanguageForPath('src/Main.kt') === null);
  }
  rmSync(root, { recursive: true, force: true });
}

// ── 汇总 ─────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
console.log(`\n═══ P5 回归：${results.length - failed.length}/${results.length} 通过 ═══`);
if (failed.length) {
  for (const f of failed) console.log(`  失败：${f.id}`);
  process.exit(1);
}
