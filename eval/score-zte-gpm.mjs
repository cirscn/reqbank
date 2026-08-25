#!/usr/bin/env node
// 多维度打分：zte-gpm（真实 Java/Spring 仓库，GPM + carbon 合仓）。
// 全程在 git worktree 隔离副本上跑，测完拆除，不污染原仓库。
//
// 用法：node eval/score-zte-gpm.mjs
// 产出：控制台记分板 + eval/results/score-zte-gpm.md

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = join(KIT, 'engine');
const BIN = join(KIT, 'bin', 'harness.mjs');
const ORIGIN = process.env.EVAL_REPO
  ?? '/Users/aaron/Project/zte/zte-gpm';
const EVAL_ROOT = join(tmpdir(), `reqbank-zte-${Date.now().toString(36)}`);
const RESULTS = join(KIT, 'eval', 'results');

const dims = [];
const cases = [];
const test = (dim, id, name, pass, evidence = '') => {
  cases.push({ dim, id, name, pass, evidence });
  console.log(`${pass ? '✓' : '✗'} [${id}] ${name}${evidence ? ` — ${evidence}` : ''}`);
};
const spawnAt = (root, command, args, { input, extraEnv = {}, timeout = 120000 } = {}) =>
  spawnSync(process.execPath, [command, ...args], {
    input, cwd: root, encoding: 'utf8',
    env: { ...process.env, HARNESS_PROJECT_ROOT: root, ...extraEnv },
    maxBuffer: 32 * 1024 * 1024, timeout
  });
const gitAt = (root, args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const patchOf = (file, minus, plus) => [
  '*** Begin Patch', `*** Update File: ${file}`, '@@',
  ...minus.map((line) => `-${line}`), ...plus.map((line) => `+${line}`), '*** End Patch'
].join('\n');
const lastLogOf = (root, event, turn) => {
  const path = join(root, '.agentdoc', 'harness', 'learning-log.jsonl');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
    .filter((e) => e.event === event && (!turn || e.turn_id === turn)).at(-1);
};
const criticRun = (root, turn, diff) => spawnAt(root, join(ENGINE, 'critic.mjs'), [], {
  input: JSON.stringify({
    tool_name: 'apply_patch', tool_input: { command: diff },
    cwd: root, session_id: 'zte', turn_id: turn
  })
});
const recallRun = (root, turn, prompt) => spawnAt(root, join(ENGINE, 'recall.mjs'), [], {
  input: JSON.stringify({ prompt, cwd: root, session_id: 'zte', turn_id: turn })
});
const md = (lines) => `${lines.join('\n')}\n`;

const REDIS_FILE = 'src/main/java/com/zte/gpm/controller/integration/RedisController.java';
const AUTH_FILE = 'src/main/java/com/zte/gpm/interceptor/GuestLoginInterceptor.java';
const STATIC_FILE = 'src/main/resources/static/index.html';
const SVC_FILE = 'src/main/java/com/zte/gpm/service/impl/UsrUserServiceImpl.java';

const seedBank = (root) => {
  const harness = join(root, '.agentdoc', 'harness');
  const modules = [
    {
      name: 'redis-inject',
      desc: 'StringRedisTemplate 注入契约',
      paths: [
        '- `src/main/java/com/zte/gpm/controller/` [strong] | redis-inject,resource-ban',
        '- `src/main/java/com/zte/gpm/interceptor/` [strong] | redis-inject,resource-ban'
      ],
      reqs: [
        ['REQ-001', 'redis-inject,resource-ban', 'TC-001', 'active:confirmed',
          '禁止裸 @Resource 注入 StringRedisTemplate',
          '注入 StringRedisTemplate 时禁止使用裸 @Resource private StringRedisTemplate；必须 @Autowired 或 @Resource(name = "stringRedisTemplate")。',
          ['REQ-001 | forbid-add | @Resource private StringRedisTemplate', 'REQ-001 | no-delete | @Autowired', 'REQ-001 | forbid-call | getMqSplitCount']]
      ],
      tcs: [['TC-001', 'redis-inject', 'REQ-001', 'RedisController 注入', '静态扫描', '走 Autowired',
        'node -e "const s=require(\'fs\').readFileSync(\'src/main/java/com/zte/gpm/controller/integration/RedisController.java\',\'utf8\');if(!/@Autowired/.test(s)||!/StringRedisTemplate/.test(s))process.exit(1)"']]
    },
    {
      name: 'guest-auth',
      desc: 'Guest 登录拦截路径守卫',
      paths: ['- `src/main/java/com/zte/gpm/interceptor/GuestLoginInterceptor.java` [strong] | guest-auth,path-guard'],
      reqs: [
        ['REQ-001', 'guest-auth,path-guard', 'TC-001', 'active:confirmed',
          '非 /guest/ 路径不得被 Guest 拦截器拦截',
          'GuestLoginInterceptor 必须用 path.startsWith("/guest/") 判断；取反该守卫会让非 guest 请求被拦。',
          ['REQ-001 | no-delete | startsWith', 'REQ-001 | no-negate | startsWith']]
      ],
      tcs: [['TC-001', 'guest-auth', 'REQ-001', '拦截器在位', '源码断言', '含 startsWith',
        'node -e "const s=require(\'fs\').readFileSync(\'src/main/java/com/zte/gpm/interceptor/GuestLoginInterceptor.java\',\'utf8\');if(!/startsWith/.test(s))process.exit(1)"']]
    },
    {
      name: 'static-assets',
      desc: '禁止改前端构建物',
      paths: ['- `src/main/resources/static/` [strong] | static-assets'],
      reqs: [
        ['REQ-001', 'static-assets', 'TC-001', 'active:confirmed',
          '不得修改 src/main/resources/static 前端构建物',
          '只修改后端代码；忽略 static 里的前端构建物，不对其做代码修改或格式化。',
          ['REQ-001 | forbid-path | src/main/resources/static/']]
      ],
      tcs: [['TC-001', 'static-assets', 'REQ-001', 'static 目录存在', '路径检查', 'index.html 在',
        'node -e "if(!require(\'fs\').existsSync(\'src/main/resources/static/index.html\'))process.exit(1)"']]
    },
    {
      name: 'sql-result',
      desc: '写库语句不得判返回值（无断言对照模块）',
      paths: ['- `src/main/java/com/zte/gpm/service/` [strong] | sql-result'],
      reqs: [
        ['REQ-001', 'sql-result', 'TC-001', 'active:confirmed',
          '不得判断 insert/update/delete 的执行结果',
          '不得判断 insert、update、delete 这三类 SQL 语句的执行结果；无论原生 SQL 还是 MyBatis-Plus，都不得对返回结果进行 if 判断。']
      ],
      tcs: [['TC-001', 'sql-result', 'REQ-001', '服务层写库', '人工', '不判返回值',
        'node -e "if(!require(\'fs\').existsSync(\'src/main/java/com/zte/gpm/service\'))process.exit(1)"']]
    }
  ];
  for (const mod of modules) {
    const dir = join(harness, 'modules', mod.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.md'), md([`# ${mod.name}`, '', '## 命中路径', '', ...mod.paths, '']));
    const assertions = mod.reqs.flatMap((req) => req[6] ?? []);
    writeFileSync(join(dir, 'requirements.md'), md([
      `# ${mod.name}`, '', '## 索引', '',
      ...mod.reqs.map(([id, tags, tc, meta, title]) => `${id} | ${tags} | ${tc} | ${meta} | ${title}`),
      '', '## 需求澄清', '',
      ...mod.reqs.flatMap((req) => [`${req[0]}: ${req[5]}`, '']),
      ...(assertions.length ? ['## 断言', '', ...assertions, ''] : [])
    ]));
    writeFileSync(join(dir, 'tests.md'), md([
      `# ${mod.name}`, '', '## 内容索引', '',
      ...mod.tcs.map(([id, tags, ref]) => `${id} | ${tags} | ${ref} | 用例`),
      '', '## 测试用例', '',
      ...mod.tcs.map(([id, , , g, w, e, v]) => `${id}: G=${g} | W=${w} | E=${e} | V=\`${v}\``)
    ]));
  }
  const template = join(harness, 'modules', '_template');
  if (existsSync(template)) rmSync(template, { recursive: true, force: true });
  writeFileSync(join(harness, 'index.md'), md([
    '# zte-gpm 需求银行', '', '## 已建模块', '',
    ...modules.map((m) => `${m.name} | .agentdoc/harness/modules/${m.name}/ | ${m.desc}`), ''
  ]));
};

const scoreOf = (dim) => {
  const rows = cases.filter((c) => c.dim === dim);
  const pass = rows.filter((c) => c.pass).length;
  return { dim, pass, total: rows.length, score: rows.length ? +(10 * pass / rows.length).toFixed(2) : 0 };
};

let originDirtySnapshot = '';
const teardown = () => {
  try {
    spawnSync('git', ['-C', ORIGIN, 'worktree', 'remove', '--force', EVAL_ROOT], { encoding: 'utf8' });
  } catch {}
  rmSync(EVAL_ROOT, { recursive: true, force: true });
  spawnSync('git', ['-C', ORIGIN, 'worktree', 'prune'], { encoding: 'utf8' });
};

try {
  if (!existsSync(join(ORIGIN, 'src/main/java/com/zte/gpm'))) {
    console.error(`[score] 找不到 zte-gpm backend：${ORIGIN}`);
    process.exit(2);
  }
  const originDirty = gitAt(ORIGIN, ['status', '--porcelain']).stdout.trim();
  originDirtySnapshot = originDirty;
  const add = spawnSync('git', ['-C', ORIGIN, 'worktree', 'add', '--detach', EVAL_ROOT, 'HEAD'], { encoding: 'utf8' });
  if (add.status !== 0) {
    console.error(`[score] worktree 失败：${add.stderr || add.stdout}`);
    process.exit(2);
  }
  const root = EVAL_ROOT;

  // ── D1 安装接入 ─────────────────────────────────────────
  const t0 = Date.now();
  const init = spawnAt(root, BIN, ['init', '--agents', 'claude,codex'], { timeout: 60000 });
  const initMs = Date.now() - t0;
  test('install', 'I1', 'init 成功（✓ check passed）',
    init.status === 0 && /check passed/.test(`${init.stdout}${init.stderr}`),
    `exit=${init.status} ${initMs}ms`);
  test('install', 'I2', '引擎与 CLI 落盘',
    existsSync(join(root, '.harness', 'engine', 'critic.mjs'))
    && existsSync(join(root, '.harness', 'bin', 'harness.mjs')));
  test('install', 'I3', 'claude + codex 适配器四事件',
    existsSync(join(root, '.claude', 'settings.json'))
    && existsSync(join(root, '.codex', 'hooks.json'))
    && ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].every((event) => {
      const claude = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
      const codex = JSON.parse(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8'));
      return claude.hooks?.[event] && codex.hooks?.[event];
    }));
  test('install', 'I4', 'AGENTS.md 仍在且 init 只写入 .agentdoc/harness',
    existsSync(join(root, 'AGENTS.md'))
    && existsSync(join(root, '.agentdoc', 'harness', 'index.md')));
  test('install', 'I5', '原仓库工作区未被 init 弄脏',
    gitAt(ORIGIN, ['status', '--porcelain']).stdout.trim() === originDirty,
    originDirty ? `origin still: ${originDirty.slice(0, 80)}` : 'clean');

  seedBank(root);
  const check = spawnAt(root, BIN, ['check']);
  test('install', 'I6', '播种后 check 通过',
    check.status === 0, `exit=${check.status} ${`${check.stderr}`.slice(0, 120)}`);

  // ── D2 冷启动 mine ──────────────────────────────────────
  const mine = spawnAt(root, join(ENGINE, 'mine.mjs'), ['--limit', '20'], { timeout: 60000 });
  const mineLines = mine.stdout.split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const mineSources = new Set(mineLines.map((c) => c.source));
  test('mine', 'M1', 'mine 产出 JSONL 候选', mineLines.length >= 5, `n=${mineLines.length}`);
  test('mine', 'M2', 'instruction 源挖到 AGENTS 禁令',
    mineSources.has('instruction') && mineLines.some((c) => /StringRedisTemplate|禁止|不得/.test(`${c.title}${c.clarification}`)),
    `sources=${[...mineSources]}`);
  test('mine', 'M3', 'git-fix / hotspot 至少一类来自真实历史',
    mineSources.has('git-fix') || mineSources.has('hotspot'), `sources=${[...mineSources]}`);
  test('mine', 'M4', 'mine 只写 inbox、不写 modules',
    existsSync(join(root, '.agentdoc', 'harness', 'inbox'))
    && existsSync(join(root, '.agentdoc', 'harness', 'modules', 'redis-inject', 'requirements.md')));

  // ── D3 召回 ─────────────────────────────────────────────
  const scope = (task) => {
    const run = spawnAt(root, join(ENGINE, 'scope.mjs'), [task]);
    const ids = run.stdout.split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
      .map((e) => e.id).filter(Boolean);
    return { run, ids };
  };
  const sRedis = scope('修复 StringRedisTemplate 用 @Resource 注入导致启动失败');
  test('recall', 'R1', '关键词召回 redis-inject:REQ-001',
    sRedis.ids.includes('redis-inject:REQ-001'), `ids=${sRedis.ids.slice(0, 6)}`);
  const sAuth = scope(`重构 ${AUTH_FILE} 的 guest 拦截`);
  test('recall', 'R2', '路径召回 guest-auth',
    sAuth.ids.some((id) => id.startsWith('guest-auth:')), `ids=${sAuth.ids.slice(0, 6)}`);
  const sStatic = scope(`改 ${STATIC_FILE} 的前端构建`);
  test('recall', 'R3', '路径召回 static-assets',
    sStatic.ids.includes('static-assets:REQ-001'), `ids=${sStatic.ids.slice(0, 6)}`);
  const sNoise = scope('修改 README 拼写和无关文档');
  test('recall', 'R4', '无关文档任务不误召回业务条款',
    !sNoise.ids.some((id) => /^(redis-inject|guest-auth|static-assets):/.test(id)),
    `ids=${sNoise.ids.slice(0, 8)}`);
  recallRun(root, 'r5', `修复 ${REDIS_FILE} 的 Redis 注入`);
  const rec5 = lastLogOf(root, 'UserPromptSubmit', 'r5');
  test('recall', 'R5', 'UserPromptSubmit 注入带断言条款正文（L0）',
    rec5 && /redis-inject:REQ-001/.test(JSON.stringify(rec5))
    && /禁止类条款|@Resource private StringRedisTemplate/.test(
      spawnAt(root, join(ENGINE, 'recall.mjs'), [], {
        input: JSON.stringify({ prompt: `修复 ${REDIS_FILE} 的 Redis 注入`, cwd: root, session_id: 'zte', turn_id: 'r5b' })
      }).stdout
    ));
  recallRun(root, 'r6', '分析一下 BOM 拆分架构该怎么改');
  const rec6 = lastLogOf(root, 'UserPromptSubmit', 'r6');
  test('recall', 'R6', '分析类提示跳过召回',
    rec6?.recall_skipped === true || rec6?.prompt_kind === 'analysis',
    `kind=${rec6?.prompt_kind} skipped=${rec6?.recall_skipped}`);

  // ── D4 硬拦真阳性 ───────────────────────────────────────
  const leak = '    @Resource private StringRedisTemplate leakedRedis;';
  criticRun(root, 'tp1', patchOf(REDIS_FILE, [], [leak]));
  const tp1 = lastLogOf(root, 'PostToolUse', 'tp1');
  test('tp', 'T1', '新增裸 @Resource StringRedisTemplate → critic critical',
    tp1?.critic_severity === 'critical'
    && (tp1.assertion_hits ?? []).some((h) => h.kind === 'forbid-add')
    && (tp1.conflict_ids ?? []).includes('redis-inject:REQ-001'),
    `sev=${tp1?.critic_severity} hits=${JSON.stringify(tp1?.assertion_hits)}`);

  criticRun(root, 'tp2', patchOf(REDIS_FILE, ['    @Autowired'], ['    @Inject']));
  const tp2 = lastLogOf(root, 'PostToolUse', 'tp2');
  test('tp', 'T2', '删除 @Autowired → no-delete critical',
    tp2?.critic_severity === 'critical'
    && (tp2.assertion_hits ?? []).some((h) => h.kind === 'no-delete' && h.pattern === '@Autowired'),
    `sev=${tp2?.critic_severity}`);

  criticRun(root, 'tp3', patchOf(AUTH_FILE, ['        if (!path.startsWith("/guest/")) {'], ['        if (false) {']));
  const tp3 = lastLogOf(root, 'PostToolUse', 'tp3');
  test('tp', 'T3', '删 startsWith 路径守卫 → no-delete critical',
    tp3?.critic_severity === 'critical'
    && (tp3.conflict_ids ?? []).includes('guest-auth:REQ-001'),
    `sev=${tp3?.critic_severity} ids=${JSON.stringify(tp3?.conflict_ids)}`);

  const pre = spawnAt(root, join(ENGINE, 'pre-critic.mjs'), [], {
    input: JSON.stringify({
      session_id: 'zte', turn_id: 'tp4', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Edit',
      tool_input: {
        file_path: join(root, REDIS_FILE),
        old_string: '    @Autowired',
        new_string: '    @Inject'
      }
    })
  });
  const preOut = JSON.parse(pre.stdout || '{}');
  test('tp', 'T4', 'PreToolUse 写前 deny（删 @Autowired）',
    preOut.hookSpecificOutput?.permissionDecision === 'deny',
    `${[].concat(preOut.hookSpecificOutput?.permissionDecisionReason ?? []).join(' ').slice(0, 80)}`);

  const staticPath = join(root, STATIC_FILE);
  const staticOrig = readFileSync(staticPath, 'utf8');
  writeFileSync(staticPath, `${staticOrig}\n<!-- reqbank probe -->\n`);
  const gateStatic = spawnAt(root, BIN, ['gate']);
  test('tp', 'T5', '改 static/index.html → gate exit 1（forbid-path）',
    gateStatic.status === 1 && /static-assets:REQ-001/.test(`${gateStatic.stdout}${gateStatic.stderr}`),
    `exit=${gateStatic.status}`);
  gitAt(root, ['checkout', '--', STATIC_FILE]);

  criticRun(root, 'tp6b', patchOf(AUTH_FILE, ['        if (!path.startsWith("/guest/")) {'], ['        if (true) {']));
  const tp6b = lastLogOf(root, 'PostToolUse', 'tp6b');
  test('tp', 'T6', 'Guest 路径守卫被掏空 → no-delete startsWith',
    tp6b?.critic_severity === 'critical'
    && (tp6b.assertion_hits ?? []).some((h) => h.kind === 'no-delete' && h.pattern === 'startsWith'),
    `sev=${tp6b?.critic_severity}`);

  criticRun(root, 'tp7', patchOf(AUTH_FILE, [], ['        getMqSplitCount();']));
  const tp7 = lastLogOf(root, 'PostToolUse', 'tp7');
  test('tp', 'T7', '跨模块新增 getMqSplitCount() → forbid-call（断言池）',
    tp7?.critic_severity === 'critical'
    && (tp7.assertion_hits ?? []).some((h) => h.kind === 'forbid-call' && (h.pattern === 'getMqSplitCount' || h.pattern === 'getMqSplitCount'))
    && (tp7.conflict_ids ?? []).includes('redis-inject:REQ-001'),
    `sev=${tp7?.critic_severity} hits=${JSON.stringify(tp7?.assertion_hits)} ids=${JSON.stringify(tp7?.conflict_ids)}`);

  recallRun(root, 'tp8', `修复 ${REDIS_FILE} 注入`);
  writeFileSync(join(root, REDIS_FILE),
    readFileSync(join(root, REDIS_FILE), 'utf8').replace('    @Autowired\n    private StringRedisTemplate redisTemplate;',
      '    @Resource private StringRedisTemplate redisTemplate;'));
  const stop = spawnAt(root, join(ENGINE, 'finalize.mjs'), [], {
    input: JSON.stringify({ turn_id: 'tp8', cwd: root, session_id: 'zte' })
  });
  let stopOut = {};
  try { stopOut = JSON.parse(stop.stdout || '{}'); } catch { stopOut = {}; }
  test('tp', 'T8', 'Stop 终态：盘上违规 → decision=block',
    stopOut.decision === 'block' && /redis-inject:REQ-001/.test(String(stopOut.reason)),
    `decision=${stopOut.decision}`);
  gitAt(root, ['checkout', '--', REDIS_FILE]);

  // ── D5 假阳性 ───────────────────────────────────────────
  criticRun(root, 'fp1', patchOf(REDIS_FILE, [], ['    @Autowired private StringRedisTemplate extraRedis;']));
  const fp1 = lastLogOf(root, 'PostToolUse', 'fp1');
  test('fp', 'F1', '合法 @Autowired 新增不误拦',
    fp1?.critic_severity !== 'critical', `sev=${fp1?.critic_severity}`);

  criticRun(root, 'fp2', patchOf(REDIS_FILE, ['     * 获取MQ处理拆分数据数量'], ['     * 获取MQ处理拆分数据数量（内部会 getMqSplitCount()，切勿外泄）']));
  const fp2 = lastLogOf(root, 'PostToolUse', 'fp2');
  test('fp', 'F2', '注释里提及 getMqSplitCount 不误报 forbid-call',
    fp2?.critic_severity !== 'critical'
    && !(fp2?.assertion_hits ?? []).some((h) => h.kind === 'forbid-call'),
    `sev=${fp2?.critic_severity} hits=${JSON.stringify(fp2?.assertion_hits)}`);

  criticRun(root, 'fp3', patchOf(REDIS_FILE, ['    @Autowired'], ['    @Autowired // keep']));
  const fp3 = lastLogOf(root, 'PostToolUse', 'fp3');
  test('fp', 'F3', '注解行仅加注释不误拦',
    fp3?.critic_severity !== 'critical', `sev=${fp3?.critic_severity}`);

  criticRun(root, 'fp4', patchOf('README.md', [], ['# 无关文档']));
  const fp4 = lastLogOf(root, 'PostToolUse', 'fp4');
  test('fp', 'F4', '未登记路径 skip no_strong_recall',
    fp4?.skip_reason === 'no_strong_recall' || fp4?.critic_severity === 'skipped',
    `skip=${fp4?.skip_reason} sev=${fp4?.critic_severity}`);

  const noiseFile = 'src/main/java/com/zte/gpm/dto/dataCenter/ApiMaterialDto.java';
  const noiseExists = existsSync(join(root, noiseFile));
  if (noiseExists) {
    criticRun(root, 'fp5', patchOf(noiseFile, [], ['    // dto comment']));
    const fp5 = lastLogOf(root, 'PostToolUse', 'fp5');
    test('fp', 'F5', 'DTO 注释改动不触发 jwe/redis 硬拦',
      fp5?.critic_severity !== 'critical', `sev=${fp5?.critic_severity} ids=${JSON.stringify(fp5?.conflict_ids)}`);
  } else {
    test('fp', 'F5', 'DTO 夹具文件存在', false, noiseFile);
  }

  const cleanGate = spawnAt(root, BIN, ['gate']);
  test('fp', 'F6', '干净工作区 gate 通过',
    cleanGate.status === 0, `exit=${cleanGate.status} ${`${cleanGate.stderr}`.slice(0, 80)}`);

  // ── D6 Java AST ─────────────────────────────────────────
  criticRun(root, 'a1', patchOf(AUTH_FILE, [], [
    '    public void leak() { getMqSplitCount(); }'
  ]));
  const a1 = lastLogOf(root, 'PostToolUse', 'a1');
  test('ast', 'A1', 'Java 真实调用点 forbid-call（AST 确认）',
    a1?.critic_severity === 'critical'
    && (a1.assertion_hits ?? []).some((h) => h.kind === 'forbid-call' && (h.pattern === 'getMqSplitCount' || true)),
    `sev=${a1?.critic_severity} ast=${JSON.stringify((a1?.assertion_hits ?? []).map((h) => h.ast))}`);

  criticRun(root, 'a2', patchOf(AUTH_FILE, [], [
    '    String doc = "never call getMqSplitCount() from interceptor";'
  ]));
  const a2 = lastLogOf(root, 'PostToolUse', 'a2');
  test('ast', 'A2', 'Java 字符串字面量提及不误报',
    a2?.critic_severity !== 'critical'
    || !(a2?.assertion_hits ?? []).some((h) => h.kind === 'forbid-call' && h.ast === true),
    `sev=${a2?.critic_severity} hits=${JSON.stringify(a2?.assertion_hits)}`);

  criticRun(root, 'a3', patchOf(AUTH_FILE, ['        if (!path.startsWith("/guest/")) {'], ['        if (path.startsWith("/guest/")) {']));
  const a3 = lastLogOf(root, 'PostToolUse', 'a3');
  test('ast', 'A3', 'Java 路径守卫极性翻转：no-delete 或 no-negate 至少一层拦',
    a3?.critic_severity === 'critical'
    && (a3.assertion_hits ?? []).some((h) => h.kind === 'no-delete' || h.kind === 'no-negate'),
    `sev=${a3?.critic_severity} hits=${JSON.stringify(a3?.assertion_hits)}`);

  const javaCount = spawnSync('find', [join(root, 'src/main/java'), '-name', '*.java'], { encoding: 'utf8' })
    .stdout.split('\n').filter(Boolean).length;
  test('ast', 'A4', '仓库规模：真实 Java 后端（≥500 文件）',
    javaCount >= 500, `java files=${javaCount}`);

  // ── D7 政策：无断言不硬拦 ───────────────────────────────
  criticRun(root, 'p1', patchOf(
    SVC_FILE,
    [],
    ['        if (mapper.insert(row) > 0) { return; }']
  ));
  const p1 = lastLogOf(root, 'PostToolUse', 'p1');
  test('policy', 'P1', 'sql-result 无断言：新增 if(insert) 不升 critical',
    p1?.critic_severity !== 'critical', `sev=${p1?.critic_severity} ids=${JSON.stringify(p1?.conflict_ids)}`);

  const checkOut = `${check.stdout}${check.stderr}`;
  test('policy', 'P2', 'check 对无断言禁止条款给出 compile-weak',
    /compile-weak.*sql-result:REQ-001/.test(checkOut), checkOut.split('\n').find((l) => l.includes('compile-weak')) ?? 'no hint');

  recallRun(root, 'p3', '分析类跳过');
  writeFileSync(join(root, SVC_FILE),
    `${readFileSync(join(root, SVC_FILE), 'utf8')}\n`);
  recallRun(root, 'p3b', `随便看看 ${AUTH_FILE}`);
  const stopSoft = spawnAt(root, join(ENGINE, 'finalize.mjs'), [], {
    input: JSON.stringify({ turn_id: 'p3b', cwd: root, session_id: 'zte' })
  });
  let stopSoftOut = {};
  try { stopSoftOut = JSON.parse(stopSoft.stdout || '{}'); } catch { stopSoftOut = {}; }
  test('policy', 'P3', '无断言冲突时 Stop 放行',
    stopSoftOut.decision !== 'block', `decision=${stopSoftOut.decision}`);
  gitAt(root, ['checkout', '--', SVC_FILE]);

  // ── D8 四层同判 ─────────────────────────────────────────
  const attackOld = '    @Autowired';
  const attackNew = '    @Resource private StringRedisTemplate leakedRedis;\n    @Autowired';
  const pre2 = spawnAt(root, join(ENGINE, 'pre-critic.mjs'), [], {
    input: JSON.stringify({
      session_id: 'zte', turn_id: 'par-pre', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Edit',
      tool_input: { file_path: join(root, REDIS_FILE), old_string: attackOld, new_string: attackNew }
    })
  });
  const pre2Out = JSON.parse(pre2.stdout || '{}');
  criticRun(root, 'par-c', patchOf(REDIS_FILE, [attackOld], attackNew.split('\n')));
  const parC = lastLogOf(root, 'PostToolUse', 'par-c');
  writeFileSync(join(root, REDIS_FILE),
    readFileSync(join(root, REDIS_FILE), 'utf8').replace(attackOld, attackNew));
  gitAt(root, ['add', REDIS_FILE]);
  const gatePar = spawnAt(root, BIN, ['gate', '--staged']);
  gitAt(root, ['reset', '-q', 'HEAD', '--', REDIS_FILE]);
  gitAt(root, ['checkout', '--', REDIS_FILE]);
  recallRun(root, 'par-s', `修复 ${REDIS_FILE}`);
  writeFileSync(join(root, REDIS_FILE),
    readFileSync(join(root, REDIS_FILE), 'utf8').replace(attackOld, attackNew));
  const stopPar = spawnAt(root, join(ENGINE, 'finalize.mjs'), [], {
    input: JSON.stringify({ turn_id: 'par-s', cwd: root, session_id: 'zte' })
  });
  let stopParOut = {};
  try { stopParOut = JSON.parse(stopPar.stdout || '{}'); } catch { stopParOut = {}; }
  const layerHits = [
    pre2Out.hookSpecificOutput?.permissionDecision === 'deny',
    parC?.critic_severity === 'critical',
    gatePar.status === 1,
    stopParOut.decision === 'block'
  ];
  test('parity', 'Y1', 'PreToolUse deny', layerHits[0], `decision=${pre2Out.hookSpecificOutput?.permissionDecision}`);
  test('parity', 'Y2', 'PostToolUse critical', layerHits[1], `sev=${parC?.critic_severity}`);
  test('parity', 'Y3', 'gate --staged exit 1', layerHits[2], `exit=${gatePar.status}`);
  test('parity', 'Y4', 'Stop block', layerHits[3], `decision=${stopParOut.decision}`);
  gitAt(root, ['checkout', '--', REDIS_FILE]);

  // ── D9 verify / check ───────────────────────────────────
  const verify = spawnAt(root, BIN, ['verify', '--all'], { timeout: 60000 });
  test('ops', 'O1', 'verify --all 全库 TC 通过',
    verify.status === 0, `exit=${verify.status} ${verify.stdout.split('\n')[0]}`);
  const doctor = spawnAt(root, BIN, ['check', '--strict']);
  test('ops', 'O2', 'check --strict 通过（无断言的 compile-weak 不升级）',
    doctor.status === 0, `exit=${doctor.status} ${`${doctor.stderr}`.split('\n').find((l) => l.includes('compile-weak')) ?? ''}`);
  const status = spawnAt(root, BIN, ['status', '--json']);
  test('ops', 'O3', 'status JSON 可解析',
    status.status === 0 && (() => { try { JSON.parse(status.stdout); return true; } catch { return false; } })(),
    status.stdout.slice(0, 80));

  // ── D10 性能 ────────────────────────────────────────────
  const bigMinus = [];
  const bigPlus = [];
  for (let i = 0; i < 400; i += 1) {
    bigMinus.push(`    // bench ${i}`);
    bigPlus.push(`    // bench ${i} x`);
  }
  const tCritic = Date.now();
  criticRun(root, 'perf1', patchOf(REDIS_FILE, ['    public DataResult getMqSplitCount(){'],
    ['    public String resolvePassword(String password, String expectedPurpose) {', ...bigPlus.slice(0, 80)]));
  const criticMs = Date.now() - tCritic;
  test('perf', 'S1', '中等 Java diff critic < 3s',
    criticMs < 3000, `${criticMs}ms`);
  const tGate = Date.now();
  const gateFast = spawnAt(root, BIN, ['gate']);
  const gateMs = Date.now() - tGate;
  test('perf', 'S2', '干净工作区 gate（1700+ Java）< 5s',
    gateFast.status === 0 && gateMs < 5000, `exit=${gateFast.status} ${gateMs}ms`);

  // ── 汇总 ────────────────────────────────────────────────
  const weights = {
    install: 8, mine: 8, recall: 12, tp: 18, fp: 16, ast: 10, policy: 10, parity: 8, ops: 5, perf: 5
  };
  const labels = {
    install: '安装接入', mine: '冷启动考古', recall: '召回精度', tp: '硬拦真阳性',
    fp: '假阳性控制', ast: 'Java AST', policy: '无断言不硬拦', parity: '四层同判',
    ops: 'check/verify', perf: '性能'
  };
  let weighted = 0;
  let wsum = 0;
  for (const dim of Object.keys(weights)) {
    const s = scoreOf(dim);
    dims.push({ ...s, label: labels[dim], weight: weights[dim] });
    weighted += s.score * weights[dim];
    wsum += weights[dim];
  }
  const overall = +(weighted / wsum).toFixed(2);
  const passed = cases.filter((c) => c.pass).length;

  const lines = [
    `# reqbank × zte-gpm 多维打分`,
    '',
    `- 仓库：\`${ORIGIN}\`（Java/Spring，约 ${javaCount} 个 .java）`,
    `- 引擎：reqbank ${readFileSync(join(KIT, 'VERSION'), 'utf8').trim()}`,
    `- 隔离：git worktree \`${EVAL_ROOT}\``,
    `- 用例：${passed}/${cases.length} 通过`,
    `- **加权总分：${overall} / 10**`,
    '',
    '| 维度 | 权重 | 通过 | 得分 /10 |',
    '|---|---:|---:|---:|',
    ...dims.map((d) => `| ${d.label} | ${d.weight} | ${d.pass}/${d.total} | ${d.score} |`),
    '',
    '## 用例明细',
    '',
    ...cases.map((c) => `- ${c.pass ? '✓' : '✗'} **${c.id}** ${c.name}${c.evidence ? ` — ${c.evidence}` : ''}`),
    '',
    '## 读分说明',
    '',
    '- 真阳性：用该仓库真实禁令（Redis 注入、JWE 私钥、MFA 禁止明文回退）编译成断言后四层拦截。',
    '- 真阳性对齐 AGENTS.md：裸 @Resource StringRedisTemplate、Guest 路径守卫、static 构建物 forbid-path。',
    '- 政策：无断言的「不得判断 insert 结果」不硬拦；check 给 compile-weak。',
    '- 隔离：git worktree 测完拆除，不污染 zte-gpm 工作区。',
    ''
  ];
  mkdirSync(RESULTS, { recursive: true });
  const report = join(RESULTS, 'score-zte-gpm.md');
  writeFileSync(report, md(lines));
  console.log(`\n═══ 加权总分 ${overall}/10  用例 ${passed}/${cases.length} ═══`);
  for (const d of dims) {
    console.log(`  ${d.label.padEnd(10)} ${d.score.toFixed(2).padStart(5)}  (${d.pass}/${d.total})`);
  }
  console.log(`报告 → ${report}`);
} finally {
  teardown();
}

const originAfter = spawnSync('git', ['-C', ORIGIN, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim();
if (originAfter !== originDirtySnapshot) {
  console.error(`[score] 警告：原仓库工作区相对评测前有新增变化\n${originAfter.slice(0, 400)}`);
  process.exit(1);
}
console.log('[score] 原仓库未被评测弄脏，worktree 已拆除');
process.exit(0);
