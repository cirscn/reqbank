#!/usr/bin/env node
// harness-kit 引擎自检：在临时目录建脚手架 → 验证召回/check/钩子进程可运行。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
// 测试隔离：所有子进程显式锚定 scratch 根，防止继承外层 HARNESS_PROJECT_ROOT；
// 剥离 CLAUDECODE / ZCODE_APP_VERSION / HARNESS_AGENTS，探测测试不随宿主环境漂移
const isolatedEnv = (root, extra = {}) => {
  // HARNESS_NO_KIMI_DETECT：kimi 探测看的是 ~/.kimi-code（用户级，env 剥不离），用开关保证隔离
  const env = { ...process.env, HARNESS_PROJECT_ROOT: root, HARNESS_NO_KIMI_DETECT: '1' };
  delete env.CLAUDECODE;
  delete env.ZCODE_APP_VERSION;
  delete env.HARNESS_AGENTS;
  return { ...env, ...extra };
};
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const scratch = mkdtempSync(join(tmpdir(), 'harness-kit-smoke-'));
try {
  spawnSync('git', ['init', '-q'], { cwd: scratch });
  mkdirSync(join(scratch, 'src'), { recursive: true });
  writeFileSync(join(scratch, 'src', 'demo.ts'), 'export const demo = () => 1;\n');

  // init（含脚手架模板拷贝）
  const init = spawnSync(process.execPath, [join(KIT_ROOT, 'bin', 'harness.mjs'), 'init', '--agents', 'codex'], {
    cwd: scratch,
    encoding: 'utf8',
    env: isolatedEnv(scratch)
  });
  expect(init.status === 0, `init exit ${init.status}: ${init.stderr}`);
  expect(existsSync(join(scratch, '.agentdoc', 'harness', 'index.md')), 'scaffold index.md missing');
  expect(existsSync(join(scratch, '.codex', 'hooks.json')), 'codex adapter missing');
  const gitignoreText = existsSync(join(scratch, '.gitignore')) ? readFileSync(join(scratch, '.gitignore'), 'utf8') : '';
  expect(gitignoreText.includes('.agentdoc/harness/hook-payloads/'), 'gitignore should ignore hook-payloads/');
  expect(gitignoreText.includes('.agentdoc/harness/learning-log.jsonl'), 'gitignore should ignore learning-log.jsonl');
  expect(!gitignoreText.includes('.claude/settings.local.json'), 'codex-only init must not touch claude local settings');

  //沉淀一条 REQ 后 scope 应命中
  const reqDir = join(scratch, '.agentdoc', 'harness', 'modules', 'demo');
  mkdirSync(reqDir, { recursive: true });
  writeFileSync(
    join(reqDir, 'index.md'),
    '# demo\n\n## 命中路径\n\n- `src/` [strong] | demo-tag\n'
  );
  writeFileSync(
    join(reqDir, 'requirements.md'),
    '# demo 需求\n\n## 索引\n\nREQ-001 | demo-tag | TC-001 | 示例契约\n\n## 需求澄清\n\nREQ-001: 示例澄清正文，说明契约边界。\n'
  );
  writeFileSync(
    join(reqDir, 'tests.md'),
    '# demo 测试\n\n## 内容索引\n\nTC-001 | demo-tag | REQ-001 | 示例验证\n\n## 测试用例\n\nTC-001: G=demo | W=修改 demo | E=契约保持 | V=echo ok\n'
  );

  const scope = spawnSync(process.execPath, [join(KIT_ROOT, 'engine', 'scope.mjs'), '示例契约 demo-tag'], {
    cwd: scratch,
    encoding: 'utf8',
    env: isolatedEnv(scratch)
  });
  expect(scope.status === 0 && scope.stdout.includes('"type":"requirement"'), `scope failed: ${scope.stderr}`);
  expect(scope.stdout.includes('demo:REQ-001'), 'scope should hit demo:REQ-001');

  // check 通过
  const check = spawnSync(process.execPath, [join(KIT_ROOT, 'bin', 'harness.mjs'), 'check'], {
    cwd: scratch,
    encoding: 'utf8',
    env: isolatedEnv(scratch)
  });
  expect(check.status === 0, `check exit ${check.status}: ${check.stdout}${check.stderr}`);

  // recall hook 进程可运行并输出 JSON
  const recall = spawnSync(process.execPath, [join(KIT_ROOT, 'engine', 'recall.mjs')], {
    cwd: scratch,
    input: JSON.stringify({ prompt: '示例契约 demo-tag 任务', cwd: scratch }),
    encoding: 'utf8',
    env: isolatedEnv(scratch)
  });
  expect(recall.status === 0, `recall exit ${recall.status}`);
  let parsed = {};
  try {
    parsed = JSON.parse(recall.stdout.trim() || '{}');
  } catch {}
  expect(Boolean(parsed?.hookSpecificOutput?.additionalContext), 'recall should inject additionalContext');

  // 自动探测：无线索空仓库必须报可操作的错，而非默认猜一个
  const bare = mkdtempSync(join(tmpdir(), 'harness-kit-smoke-bare-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: bare });
    const bareInit = spawnSync(process.execPath, [join(KIT_ROOT, 'bin', 'harness.mjs'), 'init'], {
      cwd: bare, encoding: 'utf8', env: isolatedEnv(bare)
    });
    expect(bareInit.status === 2, `bare init should exit 2, got ${bareInit.status}`);
    expect((bareInit.stderr ?? '').includes('--agents'), 'bare init error should point to --agents');

    // CLAUDECODE 环境线索 → claude 适配器直写 + init 内置 check 成功标识
    const claudeInit = spawnSync(process.execPath, [join(KIT_ROOT, 'bin', 'harness.mjs'), 'init'], {
      cwd: bare, encoding: 'utf8', env: isolatedEnv(bare, { CLAUDECODE: '1' })
    });
    expect(claudeInit.status === 0, `claude init exit ${claudeInit.status}: ${claudeInit.stderr}`);
    expect(existsSync(join(bare, '.claude', 'settings.json')), 'claude adapter missing');
    expect((claudeInit.stdout ?? '').includes('check passed'), 'init should print check passed marker');
    expect(!existsSync(join(bare, '.claude', 'harness-hooks-snippet.json')), 'fresh claude install must not use snippet fallback');

    // 已有第三方 hook 的 settings.json：自动合并、保留原条目、留 .bak
    writeFileSync(join(bare, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
      permissions: { allow: ['Bash(ls)'] }
    }, null, 2));
    const mergeInit = spawnSync(process.execPath, [join(KIT_ROOT, 'bin', 'harness.mjs'), 'init'], {
      cwd: bare, encoding: 'utf8', env: isolatedEnv(bare, { CLAUDECODE: '1' })
    });
    expect(mergeInit.status === 0, `merge init exit ${mergeInit.status}: ${mergeInit.stderr}`);
    const merged = JSON.parse(readFileSync(join(bare, '.claude', 'settings.json'), 'utf8'));
    expect(merged.permissions.allow.includes('Bash(ls)'), 'merge must preserve permissions');
    const sessionCommands = merged.hooks.SessionStart.flatMap((group) => group.hooks.map((hook) => hook.command));
    expect(sessionCommands.includes('echo hi'), 'merge must preserve third-party hook');
    expect(sessionCommands.filter((command) => command.includes('session-init.mjs')).length === 1, 'our hook appended exactly once');
    expect(existsSync(join(bare, '.claude', 'settings.json.bak')), 'merge should leave .bak backup');

    // 幂等：重复 init 对 settings.json 零变更
    const before = readFileSync(join(bare, '.claude', 'settings.json'), 'utf8');
    const againInit = spawnSync(process.execPath, [join(KIT_ROOT, 'bin', 'harness.mjs'), 'init'], {
      cwd: bare, encoding: 'utf8', env: isolatedEnv(bare, { CLAUDECODE: '1' })
    });
    expect(againInit.status === 0, `repeat init exit ${againInit.status}: ${againInit.stderr}`);
    expect(readFileSync(join(bare, '.claude', 'settings.json'), 'utf8') === before, 'repeat init must not change settings.json');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}



if (failures.length) {
  console.error('[harness-kit smoke] failed');
  for (const failure of failures) {
    console.error(`[harness-kit smoke] - ${failure}`);
  }
  process.exit(1);
}
console.log('[harness-kit smoke] passed');

const assertLlmCritic = async () => {
  const { runCriticReview, selectProhibitionCandidates } = await import('../engine/lib/critic-prompt.mjs');
  const { applyLlmCritic, llmCriticConfig } = await import('../engine/lib/llm-critic.mjs');
  const prohibitionReq = {
    scope: 'preview', id: 'REQ-005', tags: ['qrcode'],
    title: '二维码一律不展示批次号',
    clarification: '二维码一律不得展示批次号，防止信息泄露。任何来源的批次号都不得渲染到预览页。'
  };
  const diff = [
    '*** Begin Patch',
    '*** Update File: src/pages/QrcodePage.tsx',
    '@@',
    '+ const batchNumberText = BatchNumber ?? BatteryNumber;',
    '+ render(batchNumberText); // 展示批次号',
    '*** End Patch'
  ].join('\n');

  // 1) 候选选择：禁令条款命中、合规条款排除
  const compliant = { scope: 'preview', id: 'REQ-001', tags: [], title: '地址展示', clarification: '邮寄地址独立展示，禁止回退制造地址。' };
  const candidates = selectProhibitionCandidates([prohibitionReq, compliant], diff);
  expect(candidates.length === 1 && candidates[0].record.id === 'REQ-005', `llm candidate should be REQ-005 only`);

  // 2) 假 LLM 判定 violation → 升级 critical 并登记 conflict
  const base = runCriticReview({ diff, recalledReqs: [prohibitionReq] });
  const enhanced = await applyLlmCritic({
    verdict: base,
    recalledReqs: [prohibitionReq],
    diff,
    selectCandidates: selectProhibitionCandidates,
    config: { ...llmCriticConfig(), enabled: true, provider: 'openai', apiKey: 'test', model: 'test', timeoutMs: 1000 },
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"violation": true, "reason": "新增渲染批次号行为"}' } }] }) })
  });
  expect(enhanced.verdict.severity === 'critical', `llm escalation expected critical, got ${enhanced.verdict.severity}`);
  expect(
    enhanced.verdict.conflicts.some((record) => `${record.scope}:${record.id}` === 'preview:REQ-005'),
    'llm escalation should register preview:REQ-005 as conflict'
  );

  // 3) 未启用时原样返回
  const untouched = await applyLlmCritic({ verdict: base, recalledReqs: [prohibitionReq], diff, selectCandidates: selectProhibitionCandidates });
  expect(untouched.verdict === base, 'disabled llm critic must not touch verdict');
};



const assertLints = async () => {
  const lint = await import('../engine/lib/lint.mjs');
  const requirements = [
    { scope: 'demo', id: 'REQ-001', tags: ['demo-tag'], title: '示例契约', clarification: '' },
    { scope: 'demo', id: 'REQ-010', tags: ['orphan-tag'], title: '孤儿标签条款', clarification: '' },
    { scope: 'qr', id: 'REQ-002', tags: ['qrcode'], title: '二维码预览展示批次号并兼容三种来源', clarification: '三者任一存在即展示。' },
    { scope: 'qr', id: 'REQ-005', tags: ['qrcode'], title: '二维码一律不展示批次号', clarification: '防止信息泄露，任何来源都不得渲染批次号。' }
  ];
  const mods = [{ name: 'demo', paths: [{ path: 'src/', strength: 'strong', tags: ['demo-tag'] }] }];
  const tagProblems = lint.lintTagCoverage({ requirements, modulesWithMeta: mods });
  expect(tagProblems.length === 1 && tagProblems[0].id === 'REQ-010' && tagProblems[0].tag === 'orphan-tag',
    `tag coverage lint should flag only REQ-010/orphan-tag`);
  const pairs = lint.lintContradictions(requirements);
  expect(pairs.some((pair) => pair.a === 'qr:REQ-002' && pair.b === 'qr:REQ-005'),
    `contradiction lint should detect qr:REQ-002 vs qr:REQ-005`);
};

await assertLlmCritic();
await assertLints();