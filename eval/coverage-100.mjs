#!/usr/bin/env node
// reqbank 覆盖评测：在真实仓库（默认 bpms/frontend）上以 100 案例全量检查引擎能力面。
//
// 用法：
//   node eval/coverage-100.mjs                 # 跑全部 100 案例
//   node eval/coverage-100.mjs --only F        # 只跑 F 组
//   EVAL_REPO=/path/to/repo node eval/coverage-100.mjs
//
// 前置：目标仓库已完成 install + 需求银行沉淀（.harness + .agentdoc/harness）。
// 产出：控制台摘要 + eval/results/coverage-report.md + coverage-results.json。

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIT_VERSION = readFileSync(join(KIT_ROOT, 'VERSION'), 'utf8').trim();
const REPO = resolve(process.env.EVAL_REPO ?? '/Users/aaron/Project/cirscn/bpms/frontend');
const INSTALLED_BIN = join(REPO, '.harness', 'bin', 'harness.mjs');
const ENGINE = join(REPO, '.harness', 'engine');
const LOG_PATH = join(REPO, '.agentdoc', 'harness', 'learning-log.jsonl');
const RESULTS_DIR = join(KIT_ROOT, 'eval', 'results');

const RUN = (process.env.EVAL_RUN ?? Date.now().toString(36));
const onlyGroup = (() => {
  const index = process.argv.indexOf('--only');
  return index > 0 ? process.argv[index + 1] : null;
})();

const baseEnv = (extra = {}) => ({ ...process.env, HARNESS_PROJECT_ROOT: REPO, ...extra });

const runEngine = (script, args = [], { input, extraEnv, cwd = REPO } = {}) =>
  spawnSync(process.execPath, [join(ENGINE, script), ...args], {
    input, encoding: 'utf8', cwd, env: baseEnv(extraEnv), maxBuffer: 32 * 1024 * 1024, timeout: 300000
  });

const runBin = (args, { input, extraEnv, cwd = REPO } = {}) =>
  spawnSync(process.execPath, [INSTALLED_BIN, ...args], {
    input, encoding: 'utf8', cwd, env: baseEnv(extraEnv), maxBuffer: 32 * 1024 * 1024, timeout: 300000
  });

const jsonl = (text) =>
  text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

const readLog = () =>
  existsSync(LOG_PATH)
    ? readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
    : [];

const lastLog = (event, predicate = () => true) => {
  const hits = readLog().filter((record) => record.event === event && predicate(record));
  return hits.at(-1) ?? null;
};

const scopeRun = (task, args = []) => {
  const result = runEngine('scope.mjs', [...args, task]);
  return { result, entries: jsonl(result.stdout) };
};

const recallHook = (prompt, turnId, extra = {}) =>
  runEngine('recall.mjs', [], { input: JSON.stringify({ prompt, cwd: REPO, session_id: 'eval-session', turn_id: turnId, ...extra }) });

const criticHook = (diff, turnId, { extraEnv, toolInput } = {}) =>
  runEngine('critic.mjs', [], {
    input: JSON.stringify({
      tool_name: 'apply_patch',
      tool_input: toolInput ?? { command: diff },
      cwd: REPO, session_id: 'eval-session', turn_id: turnId
    }),
    extraEnv
  });

const finalizeHook = (turnId, rawInput) =>
  runEngine('finalize.mjs', [], {
    input: rawInput ?? JSON.stringify({ turn_id: turnId, cwd: REPO, session_id: 'eval-session' })
  });

const patch = (file, minus, plus) => [
  '*** Begin Patch', `*** Update File: ${file}`, '@@',
  ...minus.map((line) => `-${line}`), ...plus.map((line) => `+${line}`),
  '*** End Patch'
].join('\n');

const scratchDirs = [];
const makeScratchBank = () => {
  const dir = mkdtempSync(join(tmpdir(), 'reqbank-eval-'));
  scratchDirs.push(dir);
  mkdirSync(join(dir, '.agentdoc'), { recursive: true });
  cpSync(join(REPO, '.agentdoc', 'harness'), join(dir, '.agentdoc', 'harness'), { recursive: true });
  return dir;
};
const scratchEnv = (dir) => ({ ...process.env, HARNESS_PROJECT_ROOT: dir });

const ok = (condition, message) => { if (!condition) throw new Error(message ?? 'assertion failed'); };
const reqIds = (entries) => entries.filter((e) => e.type === 'requirement').map((e) => e.id);
const doneEntry = (entries) => entries.find((e) => e.type === 'done');

// ---------------- 案例定义 ----------------
const cases = [];
const t = (id, group, name, fn) => cases.push({ id, group, name, fn });

// A. 安装与脚手架（6）
t('A01', 'A-安装', '引擎落盘：.harness/engine 完整', () => {
  ok(existsSync(join(ENGINE, 'scope.mjs')) && existsSync(join(ENGINE, 'critic.mjs')) && existsSync(join(ENGINE, 'lib', 'harness-store.mjs')), 'engine files missing');
});
t('A02', 'A-安装', '脚手架真源：.agentdoc/harness/index.md 存在', () => {
  ok(existsSync(join(REPO, '.agentdoc', 'harness', 'index.md')), 'index.md missing');
});
t('A03', 'A-安装', 'codex 适配器：hooks.json 四事件 + matcher', () => {
  const config = JSON.parse(readFileSync(join(REPO, '.codex', 'hooks.json'), 'utf8'));
  ok(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].every((event) => config.hooks[event]), 'missing hook event');
  ok(String(config.hooks.PostToolUse[0].matcher).includes('apply_patch'), 'PostToolUse matcher wrong');
});
t('A04', 'A-安装', 'claude 适配器：settings.json 四事件且不覆盖既有 local 配置', () => {
  const settings = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf8'));
  ok(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].every((event) => settings.hooks[event]), 'missing claude hook event');
  const local = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.local.json'), 'utf8'));
  ok(!local.hooks, 'settings.local.json should stay untouched');
});
t('A05', 'A-安装', 'version 输出与 kit 一致', () => {
  const result = runBin(['version']);
  ok(result.status === 0 && result.stdout.trim() === KIT_VERSION, `version output: ${result.stdout}`);
});
t('A06', 'A-安装', '安装态 smoke 自检通过', () => {
  const result = runBin(['smoke']);
  ok(result.status === 0, `smoke exit ${result.status}: ${result.stderr}`);
});

// B. 真源解析往返（6）
const storeProbe = (code) => spawnSync(process.execPath, ['--input-type=module', '-e', `
  const store = await import(${JSON.stringify(join(ENGINE, 'lib', 'harness-store.mjs'))});
  ${code}
`], { encoding: 'utf8', cwd: REPO, env: baseEnv(), timeout: 60000 });
t('B01', 'B-解析', 'REQ 总数解析正确（36 条）', () => {
  const probe = storeProbe('console.log(store.loadAllRequirements().length)');
  ok(probe.status === 0 && probe.stdout.trim() === '36', `probe: ${probe.stdout}${probe.stderr}`);
});
t('B02', 'B-解析', 'TC 总数解析正确（37 条）', () => {
  const probe = storeProbe('console.log(store.loadAllTests().length)');
  ok(probe.status === 0 && probe.stdout.trim() === '37', `probe: ${probe.stdout}${probe.stderr}`);
});
t('B03', 'B-解析', 'REQ↔TC 双向链接完整且 V 字段非空', () => {
  const probe = storeProbe(`
    const reqs = store.loadAllRequirements(); const tests = store.loadAllTests();
    const tcIds = new Set(tests.map((r) => r.scope + ':' + r.id));
    for (const r of reqs) {
      if (!r.relatedTests?.length) throw new Error(r.scope + ':' + r.id + ' no TC');
      for (const tc of r.relatedTests) if (!tcIds.has(r.scope + ':' + tc)) throw new Error(r.scope + ':' + r.id + ' dangling TC ' + tc);
    }
    for (const tc of tests) if (!tc.verify?.[0]) throw new Error(tc.scope + ':' + tc.id + ' empty V');
    console.log('ok');`);
  ok(probe.status === 0 && probe.stdout.includes('ok'), `link integrity: ${probe.stderr || probe.stdout}`);
});
t('B04', 'B-解析', '模块与 global 命中路径行解析正确', () => {
  const probe = storeProbe(`
    const mods = store.listModulesWithMeta();
    const request = mods.find((m) => m.name === 'request');
    const global = mods.find((m) => m.name === 'global');
    if (!request || request.paths[0].path !== 'src/shared/request/' || request.paths[0].strength !== 'strong') throw new Error('request paths');
    if (!request.paths[0].tags.includes('401-guard')) throw new Error('request tags');
    if (!global || global.paths[0].path !== 'src/' || !global.paths[0].tags.includes('quality')) throw new Error('global paths');
    console.log('ok');`);
  ok(probe.status === 0 && probe.stdout.includes('ok'), `hit paths: ${probe.stderr || probe.stdout}`);
});
t('B05', 'B-解析', 'scope JSONL 携带 clarification/source/relatedTests 全字段', () => {
  const { entries } = scopeRun('latestKey 取消');
  const record = entries.find((e) => e.type === 'requirement' && e.id === 'request:REQ-008');
  ok(record, 'REQ-008 not recalled');
  ok(record.clarification?.includes('latestKey') && record.source?.endsWith('request/requirements.md'), 'fields incomplete');
  ok(record.relatedTests?.some((tc) => tc.id === 'request:TC-008' && tc.verify?.includes('pnpm exec vitest run')), 'relatedTests incomplete');
});
t('B06', 'B-解析', '根 index.md 已建模块清单与目录一致（6 模块）', () => {
  const text = readFileSync(join(REPO, '.agentdoc', 'harness', 'index.md'), 'utf8');
  for (const name of ['request', 'i18n', 'hooks', 'table', 'app-arch', 'status-code']) {
    ok(new RegExp(`^${name} \\| \\.agentdoc/harness/modules/${name}/`, 'm').test(text), `module ${name} not listed`);
  }
});

// C. scope 关键词召回（18）
const keywordCase = (id, task, expected, note) =>
  t(id, 'C-关键词召回', `${note ?? task} → ${expected}`, () => {
    const { entries } = scopeRun(task);
    ok(reqIds(entries).includes(expected), `hits=${JSON.stringify(reqIds(entries))}`);
  });
keywordCase('C01', '修复登录态 401 跳转问题', 'request:REQ-001');
keywordCase('C02', '401 重复回调防抖', 'request:REQ-002');
keywordCase('C03', '403 无权限跳转排除路径', 'request:REQ-003');
keywordCase('C05', '取消的请求还弹错误提示', 'request:REQ-007');
keywordCase('C06', 'latestKey 竞态取消', 'request:REQ-008');
keywordCase('C07', 'fix latestKey race condition cancellation', 'request:REQ-008', '英文任务');
keywordCase('C08', '语言切换并发 版本守卫', 'i18n:REQ-002');
keywordCase('C09', 'fallback 语言回退改成中文', 'i18n:REQ-003');
keywordCase('C10', '公开页语言兜底', 'i18n:REQ-004');
keywordCase('C11', '页面直接用 axios 请求', 'hooks:REQ-001');
keywordCase('C12', '列表加载失败返回空列表', 'hooks:REQ-006');
keywordCase('C13', '表格 extraParams 重复请求', 'table:REQ-002');
keywordCase('C15', 'hash 路由记忆 sessionStorage', 'app-arch:REQ-002');
keywordCase('C16', '前后台 token 存储键隔离', 'app-arch:REQ-003');
keywordCase('C17', '状态码魔法数字要换成常量', 'status-code:REQ-001', '业务码魔法数字→常量');
keywordCase('C18', '提交信息格式', 'global:REQ-004');
t('C19', 'C-关键词召回', '无关任务不误召回（README 拼写）', () => {
  const { entries } = scopeRun('修改 README 拼写');
  ok(doneEntry(entries)?.status === 'empty', `hits=${JSON.stringify(reqIds(entries))}`);
});
t('C20', 'C-关键词召回', '银行未覆盖主题不误召回（二维码批次号）', () => {
  const { entries } = scopeRun('二维码预览批次号');
  ok(doneEntry(entries)?.status === 'empty', `hits=${JSON.stringify(reqIds(entries))}`);
});

// D. scope 路径召回（8）
t('D01', 'D-路径召回', '文件路径 + 语义词 → 路径策略 + 精准条款', () => {
  const { entries } = scopeRun('src/shared/request/agent.ts 里 latestKey 取消逻辑');
  ok(entries.find((e) => e.type === 'summary')?.strategy === 'paths', 'strategy not paths');
  ok(reqIds(entries).includes('request:REQ-008'), `hits=${JSON.stringify(reqIds(entries))}`);
});
t('D02', 'D-路径召回', 'i18n 路径召回限定在 i18n/global 作用域', () => {
  const { entries } = scopeRun('重构 src/shared/i18n/index.ts 的加载顺序');
  const ids = reqIds(entries);
  ok(ids.includes('i18n:REQ-006'), `hits=${ids}`);
  ok(ids.every((id) => /^(i18n|global):/.test(id)), `scope leak: ${ids}`);
});
t('D03', 'D-路径召回', 'admin 页面路径召回 app-arch 模块', () => {
  const { entries } = scopeRun('修改 src/apps/admin/pages/UserListPage.tsx');
  ok(reqIds(entries).some((id) => id.startsWith('app-arch:')), `hits=${JSON.stringify(reqIds(entries))}`);
});
t('D04', 'D-路径召回', '组件子路径优先命中 strong 具体路径（TableComponent）', () => {
  const { entries } = scopeRun('优化 src/components/TableComponent/index.tsx 分页');
  ok(reqIds(entries).some((id) => id.startsWith('table:')), `hits=${JSON.stringify(reqIds(entries))}`);
});
t('D05', 'D-路径召回', 'hooks 路径同时召回模块条款与 global 纪律条款（top5）', () => {
  const { entries } = scopeRun('src/shared/hooks/useFetch.ts 的 loading 逻辑', ['--top', '5']);
  const ids = reqIds(entries);
  ok(ids.some((id) => id.startsWith('hooks:REQ-')) && ids.some((id) => id.startsWith('global:REQ-')), `hits=${ids}`);
});
t('D06', 'D-路径召回', '未登记路径不召回（README.md）', () => {
  const { entries } = scopeRun('调整 README.md 版式');
  ok(doneEntry(entries)?.status === 'empty', `hits=${JSON.stringify(reqIds(entries))}`);
});
t('D08', 'D-路径召回', '双文件任务跨模块召回（request + i18n，top6）', () => {
  const { entries } = scopeRun('把 src/shared/request/agent.ts 和 src/shared/i18n/index.ts 都改一下', ['--top', '6']);
  const scopes = new Set(reqIds(entries).map((id) => id.split(':')[0]));
  ok(scopes.has('request') && scopes.has('i18n'), `scopes=${[...scopes]}`);
});
t('D10', 'D-路径召回', 'stdin 管道模式等价（scope -）', () => {
  const result = runEngine('scope.mjs', ['-'], { input: '修复登录态 401 跳转问题\n' });
  ok(reqIds(jsonl(result.stdout)).includes('request:REQ-001'), `hits=${result.stdout.slice(0, 200)}`);
});

// E. recall 钩子 UserPromptSubmit（14）
t('E01', 'E-recall钩子', '实现类提示注入上下文（request:REQ-001）', () => {
  const result = recallHook('修复登录态 401 跳转问题', `t-${RUN}-t-e01`);
  const output = JSON.parse(result.stdout);
  ok(result.status === 0, 'exit nonzero');
  ok(output.hookSpecificOutput?.additionalContext?.includes('request:REQ-001'), `context=${output.hookSpecificOutput?.additionalContext?.slice(0, 120)}`);
});
t('E02', 'E-recall钩子', '路径提示走 paths 策略（REQ-008）', () => {
  const result = recallHook('修复 src/shared/request/agent.ts 里 latestKey 取消逻辑', `t-${RUN}-t-e02`);
  const output = JSON.parse(result.stdout);
  ok(output.hookSpecificOutput?.additionalContext?.includes('request:REQ-008'), 'no REQ-008');
  ok(lastLog('UserPromptSubmit', (e) => e.turn_id === `t-${RUN}-t-e02`).recall_strategy === 'paths', 'strategy not paths');
});
t('E03', 'E-recall钩子', '分析类提示跳过召回（省 token）', () => {
  recallHook('分析一下项目的路由架构应该怎么改', `t-${RUN}-t-e03`);
  const record = lastLog('UserPromptSubmit', (e) => e.turn_id === `t-${RUN}-t-e03`);
  ok(record.prompt_kind === 'analysis' && record.recall_skipped === true, `kind=${record.prompt_kind} skipped=${record.recall_skipped}`);
});
t('E04', 'E-recall钩子', 'harness 元话题跳过召回', () => {
  recallHook('看看 .agentdoc/harness 的模块结构', `t-${RUN}-t-e04`);
  const record = lastLog('UserPromptSubmit', (e) => e.turn_id === `t-${RUN}-t-e04`);
  ok(record.prompt_kind === 'harness_meta' && record.recall_skipped === true, `kind=${record.prompt_kind}`);
});
t('E05', 'E-recall钩子', '直接提交指令跳过召回（git 类）', () => {
  recallHook('直接提交代码', `t-${RUN}-t-e05`);
  const record = lastLog('UserPromptSubmit', (e) => e.turn_id === `t-${RUN}-t-e05`);
  ok(record.prompt_kind === 'git' && record.recall_skipped === true, `kind=${record.prompt_kind}`);
});
t('E06', 'E-recall钩子', '标题生成提示跳过召回（title_generation）', () => {
  recallHook('provide a short title for a task: fix login redirect', `t-${RUN}-t-e06`);
  const record = lastLog('UserPromptSubmit', (e) => e.turn_id === `t-${RUN}-t-e06`);
  ok(record.prompt_kind === 'title_generation' && record.recall_skipped === true, `kind=${record.prompt_kind}`);
});
t('E07', 'E-recall钩子', '验证类提示（localhost）照常召回', () => {
  recallHook('打开 http://localhost:5173 验证登录页', `t-${RUN}-t-e07`);
  const record = lastLog('UserPromptSubmit', (e) => e.turn_id === `t-${RUN}-t-e07`);
  ok(record.prompt_kind === 'verification' && record.recall_skipped === false, `kind=${record.prompt_kind} skipped=${record.recall_skipped}`);
});
t('E08', 'E-recall钩子', '验证类提示带业务路径注入上下文', () => {
  const result = recallHook('在浏览器打开 src/apps/portal/pages/OrdinaryQrcodePage.tsx 验证二维码', `t-${RUN}-t-e08`);
  const output = JSON.parse(result.stdout);
  ok(output.hookSpecificOutput?.additionalContext?.includes('app-arch:'), `context=${output.hookSpecificOutput?.additionalContext?.slice(0, 120)}`);
});
t('E09', 'E-recall钩子', '无命中提示不注入空上下文', () => {
  const result = recallHook('微调桌面壁纸配色', `t-${RUN}-t-e09`);
  const output = JSON.parse(result.stdout);
  ok(!output.hookSpecificOutput?.additionalContext, 'unexpected context');
});
t('E10', 'E-recall钩子', '待初始化高风险模块命中提示（tools/ → i18n-tooling）', () => {
  const result = recallHook('tools/check.cjs export cleanup', `t-${RUN}-t-e10`);
  const output = JSON.parse(result.stdout);
  ok(output.hookSpecificOutput?.additionalContext?.includes('待初始化模块命中'), 'no pending hint');
  ok(output.hookSpecificOutput.additionalContext.includes('i18n-tooling'), 'wrong pending module');
});
t('E11', 'E-recall钩子', '坏 JSON stdin fail-open（exit 0 + 记录 parse_error）', () => {
  const result = runEngine('recall.mjs', [], { input: 'not-json{{' });
  ok(result.status === 0, `exit ${result.status}`);
  ok(lastLog('UserPromptSubmit', (e) => e.parse_error)?.parse_error, 'parse_error not logged');
});
t('E12', 'E-recall钩子', '空 stdin fail-open 输出空 JSON', () => {
  const result = runEngine('recall.mjs', [], { input: '' });
  ok(result.status === 0 && JSON.parse(result.stdout).hookSpecificOutput, `exit ${result.status} out=${result.stdout}`);
});
t('E13', 'E-recall钩子', 'learning-log 字段完整（kind/hits/strategy）', () => {
  const record = lastLog('UserPromptSubmit', (e) => e.turn_id === `t-${RUN}-t-e01`);
  ok(record.prompt_kind === 'implementation', `kind=${record.prompt_kind}`);
  ok(record.recall_hits?.includes('request:REQ-001'), `hits=${record.recall_hits}`);
  ok(Array.isArray(record.keyword_count) === false && record.keyword_count > 0, 'keyword_count');
});
t('E15', 'E-recall钩子', '流程反馈类提示（本末倒置）跳过召回', () => {
  recallHook('提交代码前为什么不在浏览器验证，本末倒置', `t-${RUN}-t-e15`);
  const record = lastLog('UserPromptSubmit', (e) => e.turn_id === `t-${RUN}-t-e15`);
  ok(record.prompt_kind === 'process_feedback' && record.recall_skipped === true, `kind=${record.prompt_kind}`);
});

// F. critic 钩子 PostToolUse（18）
const CONFLICT_DIFF = patch('src/shared/request/agent.ts', [
  '  if (isMessageHandledError(error)) return;',
  '  // 守卫缺失会让同一错误重复弹出',
  '  throw toRequestError(error);'
], ['  notifyAlways(error);']);
t('F01', 'F-critic钩子', '合规 diff：REQ-004 covered 且不注入', () => {
  const diff = patch('src/shared/request/agent.ts', [], [
    '  if (!isSuccessCode(payload.code)) {',
    "    showErrorFeedback(extractBusinessMessage(payload));",
    '    error.businessMessageShown = true;',
    '    error.skipMessage = true;',
    '  }'
  ]);
  const result = criticHook(diff, `t-${RUN}-t-f01`);
  const output = JSON.parse(result.stdout);
  ok(result.status === 0, `exit ${result.status}`);
  ok(!output.hookSpecificOutput?.additionalContext, 'should not inject');
  const record = lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-t-f01`);
  ok(record.critic_severity !== 'critical', `severity=${record.critic_severity}`);
  ok(record.covered_ids.includes('request:REQ-005'), `covered=${record.covered_ids}`);
});
t('F02', 'F-critic钩子', '删除守卫 diff：REQ-006 判 critical 并注入 + 不阻断', () => {
  const result = criticHook(CONFLICT_DIFF, `t-${RUN}-t-f02`);
  const output = JSON.parse(result.stdout);
  ok(result.status === 0, `exit ${result.status}`);
  ok(output.decision === undefined, 'PostToolUse must not carry decision');
  ok(output.hookSpecificOutput?.additionalContext?.includes('request:REQ-006'), `context=${output.hookSpecificOutput?.additionalContext?.slice(0, 120)}`);
  const record = lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-t-f02`);
  ok(record.critic_severity === 'critical' && record.conflict_ids.includes('request:REQ-006'), `severity=${record.critic_severity} conflicts=${record.conflict_ids}`);
  ok(record.would_block === false, 'would_block must stay false in observe mode');
});
t('F03', 'F-critic钩子', '语义无关 diff：warning 不注入', () => {
  const diff = patch('src/shared/request/agent.ts', [], ["  const THEME = 'dark-mode';"]);
  const result = criticHook(diff, `t-${RUN}-t-f03`);
  const output = JSON.parse(result.stdout);
  ok(!output.hookSpecificOutput?.additionalContext, 'weak must not inject');
  const record = lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-t-f03`);
  ok(record.critic_severity === 'warning' && record.weak_ids.length > 0, `severity=${record.critic_severity} weak=${record.weak_ids}`);
});
t('F04', 'F-critic钩子', '未登记文件 diff：跳过召回输出空 JSON', () => {
  const diff = patch('README.md', [], ['# updated docs']);
  const result = criticHook(diff, `t-${RUN}-t-f04`);
  ok(result.status === 0 && result.stdout.trim() === '{}', `out=${result.stdout}`);
  ok(lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-t-f04`).skip_reason === 'no_strong_recall', 'skip_reason');
});
t('F05', 'F-critic钩子', '否定词整词边界回归：notification 不劫持极性', () => {
  const diff = patch('src/shared/request/agent.ts', [
    '  config.headers.i18n = getCurrentApiLanguage();',
    "  notification.info('headers applied');",
    '  delete config.headers.Authorization;'
  ], ['  applyDefaultHeaders(config);']);
  criticHook(diff, `t-${RUN}-t-f05`);
  const record = lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-t-f05`);
  ok(record.critic_severity !== 'critical', `notification substring hijack: severity=${record.critic_severity}`);
  ok(record.conflict_ids.length === 0, `conflicts=${record.conflict_ids}`);
});
t('F06', 'F-critic钩子', '新增含 must not 守卫词可抵消删除侧冲突', () => {
  const diff = patch('src/shared/request/agent.ts', [
    '  if (isMessageHandledError(error)) {',
    '    return;',
    '  }',
    '  error.skipMessage = true;',
    '  error.businessMessageShown = true;'
  ], ['  // must not duplicate the notice display']);
  criticHook(diff, `t-${RUN}-t-f06`);
  const record = lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-t-f06`);
  ok(record.conflict_ids.length === 0, `conflicts=${record.conflict_ids}`);
});
t('F07', 'F-critic钩子', '同回合重复冲突抑制（duplicate_context）', () => {
  const result = criticHook(CONFLICT_DIFF, `t-${RUN}-t-f02`);
  ok(result.stdout.trim() === '{}', `out=${result.stdout}`);
  const record = lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-t-f02`);
  ok(record.additional_context_emitted === false && record.suppressed_reason === 'duplicate_context', `emitted=${record.additional_context_emitted} reason=${record.suppressed_reason}`);
});
t('F09', 'F-critic钩子', '多文件 patch 只召回登记模块', () => {
  const diff = ['*** Begin Patch',
    '*** Update File: src/shared/request/agent.ts', '@@',
    '-  if (isMessageHandledError(error)) return;',
    '-  // 守卫缺失会让同一错误重复弹出',
    '-  throw toRequestError(error);',
    '*** Update File: README.md', '@@', '+ docs', '*** End Patch'].join('\n');
  criticHook(diff, `t-${RUN}-t-f09`);
  const record = lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-t-f09`);
  ok(record.recall_ids.every((id) => /^(request|global):/.test(id)), `recall leak=${record.recall_ids}`);
  ok(record.conflict_ids.includes('request:REQ-006'), `conflicts=${record.conflict_ids}`);
});
t('F10', 'F-critic钩子', '坏 JSON stdin fail-open（exit 0）', () => {
  const result = runEngine('critic.mjs', [], { input: '{{{' });
  ok(result.status === 0 && result.stdout.trim() === '{}', `exit ${result.status} out=${result.stdout}`);
});
t('F12', 'F-critic钩子', 'table 模块合规 diff covered（REQ-002/003）', () => {
  const diff = patch('src/components/TableComponent/index.tsx', [], [
    '  const memoizedExtraParams = useMemo(() => extraParams, [extraParams]);',
    '  tableRef.current?.refresh();',
    '  refreshData(page);',
    '  // extraParams wrapped in useMemo per table contract'
  ]);
  criticHook(diff, `t-${RUN}-t-f12`);
  const record = lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-t-f12`);
  ok(record.critic_severity !== 'critical', `severity=${record.critic_severity}`);
  ok(record.covered_ids.includes('table:REQ-002'), `covered=${record.covered_ids}`);
  ok([...record.covered_ids, ...record.weak_ids].some((id) => id === 'table:REQ-003' || id === 'table:TC-003'), `covered=${record.covered_ids} weak=${record.weak_ids}`);
});
t('F13', 'F-critic钩子', 'hooks 守卫删除冲突（onError 守卫 REQ-003）', () => {
  const diff = patch('src/shared/hooks/useFetch.ts', [
    '  // onError 判定：已处理错误跳过守卫',
    '  if (isMessageHandledError(error)) return;',
    '  if (isCanceledRequestError(error)) return;',
    '  showErrorMessage(error);'
  ], ['  notify(error);']);
  criticHook(diff, `t-${RUN}-t-f13`);
  const record = lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-t-f13`);
  ok(record.critic_severity === 'critical' && record.conflict_ids.includes('hooks:REQ-003'), `severity=${record.critic_severity} conflicts=${record.conflict_ids}`);
});
t('F14', 'F-critic钩子', 'i18n 并发守卫删除冲突（REQ-002）', () => {
  const diff = patch('src/shared/i18n/index.ts', [
    '  languageChangeVersion += 1;',
    '  const currentChangeVersion = languageChangeVersion;',
    '  if (currentChangeVersion !== version) return false;',
    '  await languageChangeQueue.run(task);'
  ], ['  applyImmediately();']);
  criticHook(diff, `t-${RUN}-t-f14`);
  const record = lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-t-f14`);
  ok(record.critic_severity === 'critical' && record.conflict_ids.includes('i18n:REQ-002'), `severity=${record.critic_severity} conflicts=${record.conflict_ids}`);
});
t('F15', 'F-critic钩子', 'app-arch 路由记忆守卫删除冲突（REQ-002）', () => {
  const diff = patch('src/apps/portal/App.tsx', [
    '  if (!shouldRememberHashPath(pathname)) return;',
    '  sessionStorage.setItem(`bp:last-app-route:${pathname}`, location.href);',
    '  navigateToLoginRoute();'
  ], ['  skipRemembering();']);
  criticHook(diff, `t-${RUN}-t-f15`);
  const record = lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-t-f15`);
  ok(record.critic_severity === 'critical' && record.conflict_ids.includes('app-arch:REQ-002'), `severity=${record.critic_severity} conflicts=${record.conflict_ids}`);
});
t('F16', 'F-critic钩子', '标签精准可达：BaseButtonGroup 路径召回 REQ-004', () => {
  const diff = patch('src/components/BaseButtonGroup/ConfirmableButton.tsx', [], [
    '  const { alertMessage } = item;',
    '  if (alertMessage) {',
    '    await confirm({ content: alertMessage });',
    '  }'
  ]);
  criticHook(diff, `t-${RUN}-t-f16`);
  const record = lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-t-f16`);
  ok(record.recall_ids.includes('table:REQ-004'), `recall=${record.recall_ids}`);
});
t('F17', 'F-critic钩子', 'status-code 模块 covered 判定', () => {
  const diff = patch('src/shared/constants/statusCode.ts', [], [
    '  export const STATUS_CODE = {',
    '    SUCCESS: 200,',
    '    SUCCESS_ALT: 0,',
    '    LOGIN_OUT: 401,',
    '    NO_AUTH: 403',
    '  } as const;'
  ]);
  criticHook(diff, `t-${RUN}-t-f17`);
  const record = lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-t-f17`);
  ok(record.covered_ids.includes('status-code:REQ-001'), `covered=${record.covered_ids}`);
});
t('F19', 'F-critic钩子', '空 old/new 的 no-op Edit 优雅跳过（Edit 形状解析见 K 组）', () => {
  const result = criticHook(null, `t-${RUN}-t-f19`, { toolInput: { file_path: 'src/shared/request/agent.ts', old_string: '', new_string: '' } });
  ok(result.status === 0 && result.stdout.trim() === '{}', `out=${result.stdout}`);
  ok(lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-t-f19`).skip_reason === 'no_strong_recall', 'skip_reason');
});
t('F20', 'F-critic钩子', 'LLM 复核默认关闭（fail-open）', () => {
  const record = lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-t-f03`);
  ok(record.llm_critic?.enabled === false && record.llm_critic?.violations?.length === 0, `llm=${JSON.stringify(record.llm_critic)}`);
});
t('F21', 'F-critic钩子', 'HARNESS_LLM_CRITIC=1 无 key 时优雅跳过', () => {
  const result = criticHook(CONFLICT_DIFF, `t-${RUN}-t-f21`, { extraEnv: { HARNESS_LLM_CRITIC: '1', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
  ok(result.status === 0, `exit ${result.status}`);
  const record = lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-t-f21`);
  ok(record.conflict_ids.includes('request:REQ-006'), 'deterministic conflict must still fire');
  ok((record.llm_critic?.violations ?? []).length === 0, 'no llm violations without key');
});

// G. finalize Stop 钩子（8）
const G01_TURN = `t-${RUN}-t-g01`;
recallHook('错误提示重复弹出两次', G01_TURN);
criticHook(CONFLICT_DIFF, G01_TURN);
t('G01', 'G-Stop门禁', '确定性冲突回合被硬拦截（block）', () => {
  const result = finalizeHook(G01_TURN);
  const output = JSON.parse(result.stdout);
  ok(output.decision === 'block', `decision=${output.decision}`);
  ok(String(output.reason).includes('request:REQ-006'), `reason=${output.reason}`);
  ok(lastLog('Stop', (e) => e.turn_id === G01_TURN).blocked === true, 'blocked flag');
});
const G02_TURN = `t-${RUN}-t-g02`;
recallHook('latestKey 竞态取消问题', G02_TURN);
criticHook(patch('src/shared/request/agent.ts', [], ['  // refactor latestRequestControllers scope key docs']), G02_TURN);
t('G02', 'G-Stop门禁', '干净回合放行（allow）', () => {
  const result = finalizeHook(G02_TURN);
  const output = JSON.parse(result.stdout);
  ok(output.decision === undefined && Object.keys(output).length === 0, `output=${result.stdout}`);
  ok(lastLog('Stop', (e) => e.turn_id === G02_TURN).decision === 'allow', 'decision log');
});
t('G03', 'G-Stop门禁', '仅召回未编辑的回合放行', () => {
  recallHook('取消的请求还弹错误提示', `t-${RUN}-t-g03`);
  const result = finalizeHook(`t-${RUN}-t-g03`);
  ok(JSON.parse(result.stdout).decision === undefined, `out=${result.stdout}`);
});
t('G04', 'G-Stop门禁', '未知 turn_id 放行不误伤', () => {
  const result = finalizeHook(`t-${RUN}-t-never-exists`);
  ok(result.status === 0 && JSON.parse(result.stdout).decision === undefined, `out=${result.stdout}`);
});
t('G05', 'G-Stop门禁', '坏 payload 走硬门禁（记录并 block）', () => {
  const result = finalizeHook(null, '{{{');
  ok(result.status === 0, `exit ${result.status}`);
  ok(JSON.parse(result.stdout).decision === 'block', `out=${result.stdout}`);
});
t('G06', 'G-Stop门禁', '分析类回合不做脏文件审计（gate skipped）', () => {
  recallHook('分析一下项目的路由架构应该怎么改', `t-${RUN}-t-g06`);
  finalizeHook(`t-${RUN}-t-g06`);
  const record = lastLog('Stop', (e) => e.turn_id === `t-${RUN}-t-g06`);
  ok(record.dirty_business_file_gate_mode === 'skipped', `gate=${record.dirty_business_file_gate_mode}`);
});
t('G07', 'G-Stop门禁', 'Stop 日志含全库 REQ 计数（36）', () => {
  const record = lastLog('Stop', (e) => e.turn_id === G01_TURN);
  ok(record.total_req_count === 36, `total_req_count=${record.total_req_count}`);
});
t('G08', 'G-Stop门禁', '仅 weak critic 的回合放行（warning 不拦截）', () => {
  recallHook('网络层小改动', `t-${RUN}-t-g08`);
  criticHook(patch('src/shared/request/agent.ts', [], ["  const THEME = 'dark';"]), `t-${RUN}-t-g08`);
  const result = finalizeHook(`t-${RUN}-t-g08`);
  ok(JSON.parse(result.stdout).decision === undefined, `out=${result.stdout}`);
});

// H. verify 命中即测（6）
t('H01', 'H-verify', '--tc 直跑快速源码断言（TC-001）', () => {
  const result = runBin(['verify', '--tc', 'request:TC-001']);
  ok(result.status === 0 && result.stdout.includes('✓'), `exit ${result.status} out=${result.stdout}`);
});
t('H02', 'H-verify', '失败命令使 verify 以 exit 1 结束（scratch 隔离）', () => {
  const scratch = makeScratchBank();
  const testsPath = join(scratch, '.agentdoc', 'harness', 'modules', 'request', 'tests.md');
  writeFileSync(testsPath, readFileSync(testsPath, 'utf8')
    .replace('## 内容索引', '## 内容索引\n\nTC-099 | error-feedback | REQ-001 | 失败探针')
    + '\nTC-099: G=失败 | W=执行 | E=退出3 | V=`node -e "process.exit(3)"`\n');
  const result = spawnSync(process.execPath, [join(ENGINE, 'verify.mjs'), '--tc', 'request:TC-099'], { encoding: 'utf8', cwd: scratch, env: scratchEnv(scratch), timeout: 60000 });
  ok(result.status === 1, `exit ${result.status}`);
  ok(result.stdout.includes('✗'), `out=${result.stdout}`);
});
t('H03', 'H-verify', '人工项 TC 跳过执行不失败', () => {
  const result = runBin(['verify', '--tc', 'table:TC-002']);
  ok(result.status === 0 && result.stdout.includes('人工项'), `exit ${result.status} out=${result.stdout}`);
});
t('H04', 'H-verify', '未知 TC id 跳过且不失败', () => {
  const result = runBin(['verify', '--tc', 'ghost:TC-999']);
  ok(result.status === 0 && result.stderr.includes('未找到'), `exit ${result.status} out=${result.stdout} err=${result.stderr}`);
});
t('H05', 'H-verify', '裸 verify 自动执行最近召回回合的 TC', () => {
  recallHook('skipMessage businessMessageShown 已提示错误守卫', `t-${RUN}-t-h05`);
  const result = runBin(['verify']);
  ok(result.status === 0, `exit ${result.status} out=${result.stdout.slice(0, 300)}`);
  ok(/待执行 [1-9]\d* 条/.test(result.stdout), `out=${result.stdout.slice(0, 120)}`);
});
t('H06', 'H-verify', 'pnpm 真实单测 TC 通过（agent.test.ts）', () => {
  const result = runBin(['verify', '--tc', 'request:TC-008']);
  ok(result.status === 0, `exit ${result.status} out=${result.stdout.slice(-300)}`);
});

// I. check / lint（8）
t('I01', 'I-check', '真源银行 check 通过', () => {
  const result = runBin(['check']);
  ok(result.status === 0 && result.stdout.includes('passed'), `exit ${result.status} ${result.stderr}`);
});
t('I02', 'I-check', 'check --strict 通过（无矛盾对 + 标签全覆盖）', () => {
  const result = runBin(['check', '--strict']);
  ok(result.status === 0, `exit ${result.status} ${result.stderr}`);
});
t('I03', 'I-check', '模块缺 tests.md → check 失败并指明', () => {
  const scratch = makeScratchBank();
  rmSync(join(scratch, '.agentdoc', 'harness', 'modules', 'request', 'tests.md'));
  const result = spawnSync(process.execPath, [INSTALLED_BIN, 'check'], { encoding: 'utf8', cwd: scratch, env: scratchEnv(scratch), timeout: 60000 });
  ok(result.status === 1 && result.stderr.includes('missing tests.md'), `exit ${result.status} ${result.stderr}`);
});
t('I04', 'I-check', '孤儿标签 → tag-coverage 拦截', () => {
  const scratch = makeScratchBank();
  const reqPath = join(scratch, '.agentdoc', 'harness', 'modules', 'request', 'requirements.md');
  writeFileSync(reqPath, readFileSync(reqPath, 'utf8').replace('REQ-001 | 401-guard |', 'REQ-001 | 401-guard,ghost-tag |'));
  const result = spawnSync(process.execPath, [INSTALLED_BIN, 'check'], { encoding: 'utf8', cwd: scratch, env: scratchEnv(scratch), timeout: 60000 });
  ok(result.status === 1 && result.stderr.includes('tag-coverage') && result.stderr.includes('ghost-tag'), `exit ${result.status} ${result.stderr}`);
});
t('I05', 'I-check', '真矛盾对：非 strict 警告 / strict 失败', () => {
  const scratch = makeScratchBank();
  const dir = join(scratch, '.agentdoc', 'harness', 'modules', 'qr-demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.md'), '# qr-demo\n\n## 命中路径\n\n- `src/apps/portal/pages/` [strong] | qrcode\n');
  writeFileSync(join(dir, 'requirements.md'), '# qr-demo 需求\n\n## 索引\n\nREQ-101 | qrcode | TC-101 | 二维码一律不展示批次号\nREQ-102 | qrcode | TC-102 | 二维码展示批次号并兼容三种来源\n\n## 需求澄清\n\nREQ-101: 二维码一律不得展示批次号，防止信息泄露。任何来源的批次号都不得渲染。\nREQ-102: 预览页二维码需要展示批次号，兼容三种来源任一存在即展示。\n');
  writeFileSync(join(dir, 'tests.md'), '# qr-demo 测试\n\n## 内容索引\n\nTC-101 | qrcode | REQ-101 | 示例\nTC-102 | qrcode | REQ-102 | 示例\n\n## 测试用例\n\nTC-101: G=示例 | W=示例 | E=示例 | V=人工核查\nTC-102: G=示例 | W=示例 | E=示例 | V=人工核查\n');
  const loose = spawnSync(process.execPath, [INSTALLED_BIN, 'check'], { encoding: 'utf8', cwd: scratch, env: scratchEnv(scratch), timeout: 60000 });
  ok(loose.status === 0, `loose exit ${loose.status}`);
  ok(loose.stderr.includes('疑似矛盾'), `loose stderr=${loose.stderr}`);
  const strict = spawnSync(process.execPath, [INSTALLED_BIN, 'check', '--strict'], { encoding: 'utf8', cwd: scratch, env: scratchEnv(scratch), timeout: 60000 });
  ok(strict.status === 1 && strict.stderr.includes('疑似矛盾'), `strict exit ${strict.status}`);
});
t('I06', 'I-check', '模板占位符残留 → check 失败', () => {
  const scratch = makeScratchBank();
  const reqPath = join(scratch, '.agentdoc', 'harness', 'modules', 'request', 'requirements.md');
  writeFileSync(reqPath, `${readFileSync(reqPath, 'utf8')}\nREQ-098 | demo | TC-001 | <模块名称> 残留 [YYYY-MM-DD]\n`);
  const result = spawnSync(process.execPath, [INSTALLED_BIN, 'check'], { encoding: 'utf8', cwd: scratch, env: scratchEnv(scratch), timeout: 60000 });
  ok(result.status === 1 && result.stderr.includes('placeholders'), `exit ${result.status} ${result.stderr}`);
});
t('I07', 'I-check', 'global/index.md 缺失 → check 失败', () => {
  const scratch = makeScratchBank();
  rmSync(join(scratch, '.agentdoc', 'harness', 'global', 'index.md'));
  const result = spawnSync(process.execPath, [INSTALLED_BIN, 'check'], { encoding: 'utf8', cwd: scratch, env: scratchEnv(scratch), timeout: 60000 });
  ok(result.status === 1 && result.stderr.includes('global/index.md'), `exit ${result.status} ${result.stderr}`);
});
t('I08', 'I-check', '通用标签（generic）豁免 tag-coverage 强校验', () => {
  const scratch = makeScratchBank();
  const reqPath = join(scratch, '.agentdoc', 'harness', 'modules', 'request', 'requirements.md');
  writeFileSync(reqPath, readFileSync(reqPath, 'utf8').replace('REQ-010 | api-contract |', 'REQ-010 | api-contract,request |'));
  const result = spawnSync(process.execPath, [INSTALLED_BIN, 'check'], { encoding: 'utf8', cwd: scratch, env: scratchEnv(scratch), timeout: 60000 });
  ok(result.status === 0, `exit ${result.status} ${result.stderr}`);
});

// J. report / impact / CLI（8）
t('J01', 'J-度量', 'report --json 指标合理（有回合有召回）', () => {
  const result = runEngine('report.mjs', ['--json']);
  const summary = JSON.parse(result.stdout);
  ok(summary.turns_prompted >= 12, `turns_prompted=${summary.turns_prompted}`);
  ok(summary.recall_hit_rate === null || (summary.recall_hit_rate >= 0 && summary.recall_hit_rate <= 1), `rate=${summary.recall_hit_rate}`);
});
t('J02', 'J-度量', 'report 人类可读输出', () => {
  const result = runEngine('report.mjs', []);
  ok(result.status === 0 && result.stdout.includes('守门体系度量'), `out=${result.stdout.slice(0, 120)}`);
});
t('J04', 'J-度量', 'critic 分布含 critical/warning/skipped 全谱', () => {
  const summary = JSON.parse(runEngine('report.mjs', ['--json']).stdout);
  const sev = summary.critic_severity;
  ok(sev.critical >= 3, `critical=${sev.critical}`);
  ok(sev.warning >= 1, `warning=${sev.warning}`);
  ok(sev.skipped >= 2, `skipped=${sev.skipped}`);
});
t('J05', 'J-度量', 'Stop 阻断计数 ≥1', () => {
  const summary = JSON.parse(runEngine('report.mjs', ['--json']).stdout);
  ok(summary.stop_blocked >= 1, `stop_blocked=${summary.stop_blocked}`);
});
t('J06', 'J-度量', 'impact 输出 JSONL 且优雅降级（无 mex 图）', () => {
  const result = runEngine('impact.mjs', ['src/shared/request/agent.ts']);
  const entries = jsonl(result.stdout);
  ok(entries[0]?.type === 'meta' && entries.at(-1)?.type === 'done', `out=${result.stdout}`);
  ok(['ok', 'empty'].includes(entries.at(-1).status), `status=${entries.at(-1).status}`);
});
t('J08', 'J-度量', 'version / 未知命令 / 空任务 的 CLI 边界', () => {
  ok(runBin(['version']).stdout.trim() === KIT_VERSION, 'version');
  ok(runBin(['no-such-cmd']).status === 2, 'unknown cmd should exit 2');
  const empty = runEngine('scope.mjs', []);
  ok(empty.status === 2 && jsonl(empty.stdout).some((e) => e.type === 'error'), 'empty task');
});
t('J10', 'J-度量', 'scope --top 1 截断命中数', () => {
  const { entries } = scopeRun('src/shared/request/ 最新Key 错误反馈', ['--top', '1']);
  ok(reqIds(entries).length <= 1, `hits=${reqIds(entries)}`);
});
t('J12', 'J-度量', 'HARNESS_PROJECT_ROOT 锚定：仓库外 cwd 也能召回', () => {
  const result = spawnSync(process.execPath, [join(ENGINE, 'scope.mjs'), '修复登录态 401 跳转问题'], {
    encoding: 'utf8', cwd: KIT_ROOT, env: baseEnv(), timeout: 60000
  });
  ok(reqIds(jsonl(result.stdout)).includes('request:REQ-001'), `out=${result.stdout.slice(0, 200)}`);
});

// K. Claude Code 形状适配（8）——payload 逐字段复刻 2026-08-24 claude 2.1.220 真实探针
//   （hook-payloads 样本：Edit={file_path,old_string,new_string,replace_all}+structuredPatch；
//    Write={file_path,content}；回合标识为 prompt_id，无 turn_id）
const claudeCritic = (payload) => runEngine('critic.mjs', [], { input: JSON.stringify(payload) });
const K01_ID = `t-${RUN}-k01`;
const claudeEditPayload = (promptId, { oldString, newString, patchLines, filePath = join(REPO, 'src/shared/request/agent.ts') } = {}) => ({
  session_id: 'eval-claude', prompt_id: promptId, cwd: REPO, permission_mode: 'default',
  effort: { level: 'xhigh' }, hook_event_name: 'PostToolUse', tool_name: 'Edit',
  tool_input: { file_path: filePath, old_string: oldString, new_string: newString, replace_all: false },
  tool_response: {
    filePath,
    structuredPatch: [{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 1, lines: patchLines }]
  }
});
const K01_GUARD_LINES = [
  '  if (isMessageHandledError(error)) return;',
  '  // 守卫缺失会让同一错误重复弹出',
  '  throw toRequestError(error);'
];
const K01_PAYLOAD = claudeEditPayload(K01_ID, {
  oldString: K01_GUARD_LINES.join('\n'),
  newString: '  notifyAlways(error);',
  patchLines: [...K01_GUARD_LINES.map((line) => `-${line}`), '+  notifyAlways(error);']
});
t('K01', 'K-claude适配', '真实 Edit 形状：守卫删除判 critical + prompt_id 归一落日志', () => {
  const result = claudeCritic(K01_PAYLOAD);
  const output = JSON.parse(result.stdout);
  ok(result.status === 0, `exit ${result.status}`);
  ok(output.hookSpecificOutput?.additionalContext?.includes('request:REQ-006'), `context=${result.stdout.slice(0, 160)}`);
  const record = lastLog('PostToolUse', (e) => e.turn_id === K01_ID);
  ok(record, 'log entry missing');
  ok(record.critic_severity === 'critical' && record.conflict_ids.includes('request:REQ-006'), `severity=${record.critic_severity} conflicts=${record.conflict_ids}`);
  ok(record.recall_path_candidates.includes('src/shared/request/agent.ts'), `paths=${record.recall_path_candidates}`);
});
t('K02', 'K-claude适配', '真实 Write 形状：新建文件不再 skipped，绝对路径归一', () => {
  const payload = {
    session_id: 'eval-claude', prompt_id: `t-${RUN}-k02`, cwd: REPO, permission_mode: 'default',
    hook_event_name: 'PostToolUse', tool_name: 'Write',
    tool_input: {
      file_path: join(REPO, 'src/shared/request/notifyHelper.ts'),
      content: 'export const notify = (payload) => {\n  if (isMessageHandledError(payload)) return;\n  showErrorFeedback(extractBusinessMessage(payload));\n};\n'
    },
    tool_response: { type: 'create', filePath: join(REPO, 'src/shared/request/notifyHelper.ts'), structuredPatch: [], originalFile: null, userModified: false }
  };
  claudeCritic(payload);
  const record = lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-k02`);
  ok(record && record.critic_severity !== 'skipped', `severity=${record?.critic_severity}`);
  ok(record.recall_path_candidates.includes('src/shared/request/notifyHelper.ts'), `paths=${record.recall_path_candidates}`);
});
t('K03', 'K-claude适配', 'recall 收到 prompt_id：归一为 turn_id 且召回照常', () => {
  const result = runEngine('recall.mjs', [], {
    input: JSON.stringify({ prompt: '修复登录态 401 跳转问题', prompt_id: `t-${RUN}-k03`, cwd: REPO, session_id: 'eval-claude' })
  });
  ok(result.status === 0, `exit ${result.status}`);
  const record = lastLog('UserPromptSubmit', (e) => e.turn_id === `t-${RUN}-k03`);
  ok(record, 'log turn_id not normalized from prompt_id');
  ok(record.recall_hits?.includes('request:REQ-001'), `hits=${record.recall_hits}`);
});
t('K04', 'K-claude适配', '同 prompt_id 重复冲突被去重（duplicate_context）', () => {
  const result = claudeCritic(K01_PAYLOAD);
  ok(result.stdout.trim() === '{}', `out=${result.stdout}`);
  const record = lastLog('PostToolUse', (e) => e.turn_id === K01_ID);
  ok(record.additional_context_emitted === false && record.suppressed_reason === 'duplicate_context', `emitted=${record.additional_context_emitted} reason=${record.suppressed_reason}`);
});
t('K05', 'K-claude适配', 'Stop 收到 prompt_id：跨钩子聚合生效，硬拦截打通', () => {
  const result = runEngine('finalize.mjs', [], {
    input: JSON.stringify({ prompt_id: K01_ID, cwd: REPO, session_id: 'eval-claude', hook_event_name: 'Stop' })
  });
  const output = JSON.parse(result.stdout);
  ok(output.decision === 'block', `decision=${output.decision}`);
  ok(String(output.reason).includes('request:REQ-006'), `reason=${output.reason}`);
});
t('K06', 'K-claude适配', 'Write 未登记路径（README）优雅跳过', () => {
  const payload = {
    session_id: 'eval-claude', prompt_id: `t-${RUN}-k06`, cwd: REPO, permission_mode: 'default',
    hook_event_name: 'PostToolUse', tool_name: 'Write',
    tool_input: { file_path: join(REPO, 'README.md'), content: '# updated' },
    tool_response: { type: 'create', filePath: join(REPO, 'README.md'), structuredPatch: [] }
  };
  const result = claudeCritic(payload);
  ok(result.status === 0 && result.stdout.trim() === '{}', `out=${result.stdout}`);
  ok(lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-k06`).skip_reason === 'no_strong_recall', 'skip_reason');
});
t('K07', 'K-claude适配', 'MultiEdit 无 structuredPatch：从 edits 数组合成 diff 仍判冲突', () => {
  const payload = {
    session_id: 'eval-claude', prompt_id: `t-${RUN}-k07`, cwd: REPO, permission_mode: 'default',
    hook_event_name: 'PostToolUse', tool_name: 'MultiEdit',
    tool_input: {
      file_path: join(REPO, 'src/shared/request/agent.ts'),
      edits: [{ old_string: K01_GUARD_LINES.join('\n'), new_string: '  notifyAlways(error);' }]
    },
    tool_response: { filePath: join(REPO, 'src/shared/request/agent.ts') }
  };
  claudeCritic(payload);
  const record = lastLog('PostToolUse', (e) => e.turn_id === `t-${RUN}-k07`);
  ok(record.critic_severity === 'critical' && record.conflict_ids.includes('request:REQ-006'), `severity=${record.critic_severity} conflicts=${record.conflict_ids}`);
});
t('K08', 'K-claude适配', '合规 Edit + Stop 放行：Claude 形状全链路不误拦', () => {
  const promptId = `t-${RUN}-k08`;
  claudeCritic(claudeEditPayload(promptId, {
    oldString: '  // latestKey scope docs',
    newString: '  // latestKey scope docs v2',
    patchLines: ['-  // latestKey scope docs', '+  // latestKey scope docs v2']
  }));
  const critic = lastLog('PostToolUse', (e) => e.turn_id === promptId);
  ok(critic.critic_severity !== 'critical', `severity=${critic.critic_severity}`);
  const result = runEngine('finalize.mjs', [], {
    input: JSON.stringify({ prompt_id: promptId, cwd: REPO, session_id: 'eval-claude', hook_event_name: 'Stop' })
  });
  ok(JSON.parse(result.stdout).decision === undefined, `out=${result.stdout}`);
});

// ---------------- 执行与报告 ----------------
const filtered = onlyGroup ? cases.filter((c) => c.group.startsWith(onlyGroup)) : cases;
if (filtered.length !== 108 && !onlyGroup) {
  console.error(`[eval] 案例数为 ${filtered.length}，应为 108`);
}
const results = [];
for (const testCase of filtered) {
  try {
    await testCase.fn();
    results.push({ ...testCase, pass: true, note: '' });
    console.log(`  ✓ ${testCase.id} ${testCase.name}`);
  } catch (error) {
    results.push({ ...testCase, pass: false, note: error.message });
    console.log(`  ✗ ${testCase.id} ${testCase.name} — ${error.message}`);
  }
}

const groups = [...new Set(results.map((r) => r.group))];
const summaryLines = groups.map((group) => {
  const items = results.filter((r) => r.group === group);
  const passed = items.filter((r) => r.pass).length;
  return `| ${group} | ${passed}/${items.length} |`;
});
const total = results.length;
const passed = results.filter((r) => r.pass).length;
const header = `# reqbank 覆盖评测报告（${REPO}）

- 时间：${new Date().toISOString()}
- 引擎：${readFileSync(join(REPO, '.harness', 'VERSION'), 'utf8').trim()}
- 结果：**${passed}/${total}**

| 组 | 通过/总数 |
|---|---|
${summaryLines.join('\n')}
`;
const failures = results.filter((r) => !r.pass);
const detail = failures.length ? `\n## 失败明细\n\n${failures.map((r) => `- **${r.id} ${r.name}**：${r.note}`).join('\n')}\n` : '\n全部通过。\n';

mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(join(RESULTS_DIR, 'coverage-report.md'), header + detail);
writeFileSync(join(RESULTS_DIR, 'coverage-results.json'), JSON.stringify(results.map(({ id, group, name, pass, note }) => ({ id, group, name, pass, note })), null, 2));
for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n[eval] ${passed}/${total} 通过；报告 → eval/results/coverage-report.md`);
process.exit(passed === total ? 0 : 1);
