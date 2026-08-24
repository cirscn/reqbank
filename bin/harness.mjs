#!/usr/bin/env node
// harness — 需求记忆脚手架 CLI
// 用法：
//   harness init [--agents codex,claude,grok]   初始化 .agentdoc/harness 脚手架并渲染 agent 适配器
//   reqbank scope <task...>                     任务 → REQ/TC 证据链（JSONL）
//   harness check                               脚手架健康检查（结构完整性 / 占位符残留）
//   harness doctor                              同 check（别名）
//   harness smoke                               引擎自检
//   harness update [--ref main]        升级引擎（不动 .agentdoc 真源）
//   harness version                     显示已安装版本
//   harness update [--ref main]        升级引擎到远端最新（不动 .agentdoc 真源）
//   harness version                    显示已安装版本
//   harness session-init|recall|critic|finalize hook 直通（供适配器配置调用）
//
// 安装位置：<repo>/.harness/bin/harness.mjs

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(BIN_DIR, '..');
const ENGINE_DIR = join(KIT_ROOT, 'engine');
const TEMPLATES_DIR = join(KIT_ROOT, 'templates', 'harness');

const HOOK_NAMES = ['session-init', 'recall', 'critic', 'finalize'];
const PACKAGE_NAME = (() => {
  try {
    return JSON.parse(readFileSync(resolve(KIT_ROOT, 'package.json'), 'utf8')).name ?? '@cirscn/reqbank';
  } catch {
    return '@cirscn/reqbank';
  }
})();

const readStdinJson = async () => {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
};

const parseArgs = (argv) => {
  const options = { agents: [], positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--agents') {
      index += 1;
      options.agents = String(argv[index] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    } else {
      options.positional.push(arg);
    }
  }
  return options;
};

const gitRoot = () => {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

const projectRoot = () => {
  if (process.env.HARNESS_PROJECT_ROOT) {
    return resolve(process.env.HARNESS_PROJECT_ROOT);
  }
  let current = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(current, '.agentdoc', 'harness'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  const root = gitRoot();
  if (root && existsSync(join(root, '.agentdoc', 'harness'))) {
    return root;
  }
  return null;
};

const cmdInit = async (options) => {
  const root = projectRoot() ?? gitRoot();
  if (!root) {
    console.error('[reqbank] 无法确定目标仓库（cwd 不在 git 仓库内且未设 HARNESS_PROJECT_ROOT）。请用 install.sh --repo 或在仓库内运行。');
    process.exit(2);
  }
  const harnessDir = join(root, '.agentdoc', 'harness');
  const fresh = !existsSync(harnessDir);

  if (fresh) {
    mkdirSync(join(root, '.agentdoc'), { recursive: true });
    cpSync(TEMPLATES_DIR, harnessDir, { recursive: true });
    console.log(`[reqbank] scaffold created: ${join(root, '.agentdoc', 'harness')}`);
  } else {
    console.log('[reqbank] scaffold exists, skipping template copy');
  }

  const engineDir = join(root, '.harness', 'engine');
  if (!existsSync(engineDir)) {
    cpSync(ENGINE_DIR, engineDir, { recursive: true });
    console.log(`[reqbank] engine installed: ${engineDir}`);
  }
  const binDir = join(root, '.harness', 'bin');
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
    cpSync(join(KIT_ROOT, 'bin', 'harness.mjs'), join(binDir, 'harness.mjs'));
    console.log(`[reqbank] cli installed: ${join(binDir, 'harness.mjs')}`);
  }

  const agents = options.agents.length
    ? options.agents
    : (process.env.HARNESS_AGENTS ?? 'codex').split(',').map((item) => item.trim()).filter(Boolean);

  const hookCommand = (hookName) =>
    `node "$(git rev-parse --show-toplevel)/.harness/engine/${hookName}.mjs"`;

  for (const agent of agents) {
    if (agent === 'codex') {
      const config = { hooks: {} };
      const events = {
        SessionStart: ['session-init'],
        UserPromptSubmit: ['recall'],
        PostToolUse: ['critic'],
        Stop: ['finalize']
      };
      for (const [event, hooks] of Object.entries(events)) {
        config.hooks[event] = [{
          matcher: event === 'PostToolUse' ? 'apply_patch|search_replace|Edit|Write|MultiEdit' : '',
          hooks: hooks.map((hookName) => ({
            type: 'command',
            command: hookCommand(hookName),
            timeout: event === 'Stop' ? 60 : 30
          }))
        }];
      }
      const codexDir = join(root, '.codex');
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(join(codexDir, 'hooks.json'), JSON.stringify(config, null, 2));
      console.log('[reqbank] codex adapter → .codex/hooks.json');
    } else if (agent === 'claude') {
      const settingsPath = join(root, '.claude', 'settings.json');
      mkdirSync(join(root, '.claude'), { recursive: true });
      const claudeHooks = {
        SessionStart: [{ hooks: [{ type: 'command', command: hookCommand('session-init'), timeout: 15 }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCommand('recall'), timeout: 30 }] }],
        PostToolUse: [{
          matcher: 'Edit|Write|MultiEdit',
          hooks: [{ type: 'command', command: hookCommand('critic'), timeout: 60 }]
        }],
        Stop: [{ hooks: [{ type: 'command', command: hookCommand('finalize'), timeout: 60 }] }]
      };
      if (!existsSync(settingsPath)) {
        writeFileSync(settingsPath, JSON.stringify({ hooks: claudeHooks }, null, 2));
        console.log('[reqbank] claude adapter → .claude/settings.json');
      } else {
        const snippetPath = join(root, '.claude', 'harness-hooks-snippet.json');
        writeFileSync(snippetPath, JSON.stringify(claudeHooks, null, 2));
        console.log(`[reqbank] claude settings 已存在，片段写入 ${snippetPath}（请手动合并到 settings.json 的 hooks 字段）`);
      }
    } else if (agent === 'grok') {
      console.log('[reqbank] grok 适配器为实验特性：请参考 README「多包仓库 / Grok 桥接」一节手动配置');
    } else {
      console.warn(`[reqbank] unknown agent: ${agent}`);
    }
  }

  console.log('\n下一步：');
  console.log('  1. 填充 .agentdoc/harness/global/index.md 的命中范围与标签');
  console.log(`  2. 用 reqbank scope "任务描述" 验证召回（当前 ${fresh ? '空脚手架，先沉淀第一条 REQ' : '已有记忆'}）`);
  console.log('  3. 提交前保持钩子静默通过；确定性冲突会被 Stop 拦截');
};

const cmdCheck = async (rest = []) => {
  const root = projectRoot();
  if (!root) {
    console.error('[reqbank] no scaffold found (run init)');
    process.exit(2);
  }
  const harnessDir = join(root, '.agentdoc', 'harness');
  const problems = [];
  for (const required of ['index.md', 'global/index.md', 'global/requirements.md', 'global/tests.md']) {
    if (!existsSync(join(harnessDir, required))) {
      problems.push(`missing: ${required}`);
    }
  }
  const modulesDir = join(harnessDir, 'modules');
  if (existsSync(modulesDir)) {
    for (const entry of await import('node:fs').then((fs) => fs.readdirSync(modulesDir))) {
      if (entry.startsWith('_') || entry.startsWith('.')) continue;
      const dir = join(modulesDir, entry);
      for (const file of ['index.md', 'requirements.md', 'tests.md']) {
        if (!existsSync(join(dir, file))) {
          problems.push(`module ${entry}: missing ${file}`);
        }
      }
      const reqText = existsSync(join(dir, 'requirements.md')) ? readFileSync(join(dir, 'requirements.md'), 'utf8') : '';
      if (/<[模块名称]>|\[YYYY-MM-DD\]/.test(reqText)) {
        problems.push(`module ${entry}: template placeholders left in requirements.md`);
      }
    }
  }
    // 结构之外：内容级 lint（标签覆盖 / 矛盾条款对）
    try {
      const store = await import(join(ENGINE_DIR, 'lib', 'harness-store.mjs'));
      const lint = await import(join(ENGINE_DIR, 'lib', 'lint.mjs'));
      const requirements = store.loadAllRequirements();
      const modulesWithMeta = store.listModulesWithMeta();
      const strict = rest.includes('--strict');
      let warnings = 0;
      for (const problem of lint.lintTagCoverage({ requirements, modulesWithMeta })) {
        problems.push(`tag-coverage: ${problem.scope}:${problem.id} 标签 "${problem.tag}" 未登记在路径行——路径召回不可达`);
      }
      const pairs = lint.lintContradictions(requirements);
      for (const pair of pairs) {
        warnings += 1;
        console.warn(`[reqbank] ⚠ 疑似矛盾条款对：${pair.a} ↔ ${pair.b}（共享主题：${pair.subject}）——请人工确认极性`);
      }
      if (warnings > 0 && strict) {
        problems.push(`${warnings} 对疑似矛盾条款（--strict 模式下视为失败）`);
      }
    } catch (error) {
      problems.push(`lint 执行失败（fail-open 忽略内容检查）: ${error.message}`);
    }

    if (problems.length) {
    console.error(`[reqbank] check failed (${problems.length}):`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  console.log('[reqbank] check passed');
};

const main = async () => {
  // CLI 自身能解析出项目根时，透传给引擎子进程——允许用户在仓库外任意 cwd 调用。
  // 锚点优先级：cwd 向上找 .agentdoc/harness → 安装位置反推（KIT_ROOT/..）→ git 根。
  const root =
    projectRoot()
    ?? (() => {
      const candidate = resolve(KIT_ROOT, '..');
      return existsSync(join(candidate, '.agentdoc', 'harness')) ? candidate : null;
    })()
    ?? gitRoot();
  if (root) {
    process.env.HARNESS_PROJECT_ROOT = root;
  }
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'init':
      return cmdInit(parseArgs(rest));
    case 'scope': {
      const result = spawnSync(process.execPath, [join(ENGINE_DIR, 'scope.mjs'), ...rest], {
        stdio: 'inherit',
        env: { ...process.env, HARNESS_PROJECT_ROOT: process.env.HARNESS_PROJECT_ROOT }
      });
      process.exit(result.status ?? 0);
      return;
    }
    case 'check':
    case 'doctor':
      return cmdCheck(rest);
    case 'update': {
      const options = parseArgs(rest);
      if (!options.positional.includes('--git') && !process.env.HARNESS_KIT_URL) {
        // npm 模式：从 registry 拉 latest 包，替换引擎层
        const root0 = projectRoot() ?? gitRoot() ?? process.cwd();
        const harnessDir0 = join(root0, '.harness');
        const before0 = existsSync(join(harnessDir0, 'VERSION')) ? readFileSync(join(harnessDir0, 'VERSION'), 'utf8').trim() : 'unknown';
        const tmp0 = mkdtempSync(join(tmpdir(), 'harness-npm-'));
        try {
          const view = spawnSync('npm view harness-kit version', { shell: true, encoding: 'utf8' });
          const latest = (view.stdout ?? '').trim();
          if (!latest) throw new Error('registry unreachable');
          if (latest === before0) {
            console.log(`[reqbank] 已是最新 ${latest}`);
            return;
          }
          const pack = spawnSync(`npm pack harness-kit@${latest} --pack-destination "${tmp0}"`, { shell: true, encoding: 'utf8' });
          const tgzName = (pack.stdout ?? '').trim().split('\n').filter(Boolean).at(-1);
          if (!tgzName) throw new Error('npm pack failed');
          spawnSync('tar', ['-xzf', join(tmp0, tgzName), '-C', tmp0]);
          const pkgDir = join(tmp0, 'package');
          rmSync(join(harnessDir0, 'engine'), { recursive: true, force: true });
          cpSync(join(pkgDir, 'engine'), join(harnessDir0, 'engine'), { recursive: true });
          cpSync(join(pkgDir, 'bin', 'harness.mjs'), join(harnessDir0, 'bin', 'harness.mjs'));
          cpSync(join(pkgDir, 'templates'), join(harnessDir0, 'templates'), { recursive: true });
          writeFileSync(join(harnessDir0, 'VERSION'), `${latest}\n`);
          console.log(`[reqbank] updated ${before0} -> ${latest}（.agentdoc/harness 真源未动）`);
        } catch (error) {
          console.error(`[reqbank] npm update failed: ${error.message}；可改用 --git`);
          process.exitCode = 1;
        } finally {
          rmSync(tmp0, { recursive: true, force: true });
        }
        return;
      }
      const remote = process.env.HARNESS_KIT_URL ?? 'git@github.com:cirscn/harness-kit.git';
      const ref = options.positional.filter((arg) => arg !== '--git')[0] ?? 'main';
      const root = projectRoot() ?? gitRoot() ?? process.cwd();
      const harnessDir = join(root, '.harness');
      if (!existsSync(harnessDir)) {
        console.error('[reqbank] not installed here (no .harness/) — run install first');
        process.exit(2);
      }
      const before = existsSync(join(harnessDir, 'VERSION')) ? readFileSync(join(harnessDir, 'VERSION'), 'utf8').trim() : 'unknown';
      const tmp = mkdtempSync(join(tmpdir(), 'harness-update-'));
      try {
        const clone = spawnSync('git', ['clone', '--depth', '1', '-q', '--branch', ref, remote, join(tmp, 'kit')], { encoding: 'utf8' });
        if (clone.status !== 0) {
          console.error(`[reqbank] update failed: cannot clone ${remote}@${ref}`);
          process.exit(1);
        }
        const kit = join(tmp, 'kit');
        rmSync(join(harnessDir, 'engine'), { recursive: true, force: true });
        cpSync(join(kit, 'engine'), join(harnessDir, 'engine'), { recursive: true });
        cpSync(join(kit, 'bin', 'harness.mjs'), join(harnessDir, 'bin', 'harness.mjs'));
        cpSync(join(kit, 'templates'), join(harnessDir, 'templates'), { recursive: true });
        if (existsSync(join(kit, 'scripts', 'smoke.mjs'))) {
          mkdirSync(join(harnessDir, 'scripts'), { recursive: true });
          cpSync(join(kit, 'scripts', 'smoke.mjs'), join(harnessDir, 'scripts', 'smoke.mjs'));
        }
        const version = readFileSync(join(kit, 'VERSION'), 'utf8').trim();
        writeFileSync(join(harnessDir, 'VERSION'), `${version}\n`);
        console.log(`[reqbank] updated ${before} -> ${version}（.agentdoc/harness 真源未动）`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
      return;
    }
    case 'report': {
      const result = spawnSync(process.execPath, [join(ENGINE_DIR, 'report.mjs'), ...rest], {
        stdio: 'inherit',
        env: { ...process.env, HARNESS_PROJECT_ROOT: process.env.HARNESS_PROJECT_ROOT }
      });
      process.exit(result.status ?? 0);
      return;
    }
    case 'impact': {
      const result = spawnSync(process.execPath, [join(ENGINE_DIR, 'impact.mjs'), ...rest], {
        stdio: 'inherit',
        env: { ...process.env, HARNESS_PROJECT_ROOT: process.env.HARNESS_PROJECT_ROOT }
      });
      process.exit(result.status ?? 0);
      return;
    }
    case 'verify': {
      const result = spawnSync(process.execPath, [join(ENGINE_DIR, 'verify.mjs'), ...rest], {
        stdio: 'inherit',
        env: { ...process.env, HARNESS_PROJECT_ROOT: process.env.HARNESS_PROJECT_ROOT }
      });
      process.exit(result.status ?? 0);
      return;
    }
    case 'version': {
      const root = projectRoot() ?? process.cwd();
      const v = join(root, '.harness', 'VERSION');
      console.log(existsSync(v) ? readFileSync(v, 'utf8').trim() : '(not installed)');
      return;
    }
    case 'smoke': {
      const smokePath = join(KIT_ROOT, 'scripts', 'smoke.mjs');
      const result = spawnSync(process.execPath, [smokePath], { stdio: 'inherit' });
      process.exit(result.status ?? 0);
      return;
    }
    case 'session-init':
    case 'recall':
    case 'critic':
    case 'finalize': {
      const input = await readStdinJson();
      const result = spawnSync(process.execPath, [join(ENGINE_DIR, `${command}.mjs`)], {
        input,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024
      });
      process.stdout.write(result.stdout.trim());
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
      process.exit(result.status ?? 0);
      return;
    }
    default:
      console.error('usage: reqbank <init|scope|check|doctor|verify|report|impact|smoke|update|version|session-init|recall|critic|finalize> [args]');
      process.exit(command ? 2 : 0);
  }
};

main().catch((error) => {
  console.error(`[reqbank] fatal: ${error.message}`);
  process.exit(0);
});
