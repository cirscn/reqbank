#!/usr/bin/env node
// harness — 需求记忆脚手架 CLI
// 用法：
//   harness init [--agents codex,claude,grok]   初始化 .agentdoc/harness 脚手架并渲染 agent 适配器
//                                               --agents 省略时自动探测（CLAUDECODE 环境线索 / .claude .codex 目录）
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
import { chmodSync, copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const options = { agents: [], positional: [], gate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--agents') {
      index += 1;
      options.agents = String(argv[index] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    } else if (arg === '--gate') {
      options.gate = true;
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

const GITIGNORE_MARKER = '# reqbank(harness) runtime artifacts';

// 事件级追加合并：同一事件下已存在相同 command 的条目跳过，保证重复 init 零重复。
const mergeClaudeHooks = (settings, claudeHooks) => {
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? { ...settings.hooks }
    : {};
  let changed = false;
  for (const [event, groups] of Object.entries(claudeHooks)) {
    const existingGroups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const knownCommands = new Set(existingGroups.flatMap((group) =>
      Array.isArray(group?.hooks) ? group.hooks.map((hook) => hook?.command).filter(Boolean) : []));
    for (const group of groups) {
      const commands = (group.hooks ?? []).map((hook) => hook.command);
      if (commands.length && commands.every((command) => knownCommands.has(command))) {
        continue;
      }
      existingGroups.push(group);
      commands.forEach((command) => knownCommands.add(command));
      changed = true;
    }
    hooks[event] = existingGroups;
  }
  return { hooks, changed };
};

// 只忽略引擎运行产物；.agentdoc 下的真源文档（modules/global）必须进版本库。
// 幂等：已存在的条目跳过；标记块已存在时只在块内补缺，避免重复块。
const ensureGitignoreEntries = (root, entries) => {
  const gitignorePath = join(root, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const present = new Set(existing.split('\n').map((line) => line.trim()));
  const missing = entries.filter((entry) => !present.has(entry));
  if (!missing.length) {
    return [];
  }
  let updated;
  const lines = existing.split('\n');
  const markerIndex = lines.findIndex((line) => line.trim() === GITIGNORE_MARKER);
  if (markerIndex >= 0) {
    lines.splice(markerIndex + 1, 0, ...missing);
    updated = lines.join('\n');
  } else {
    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    updated = `${existing}${prefix}${GITIGNORE_MARKER}\n${missing.join('\n')}\n`;
  }
  writeFileSync(gitignorePath, updated, 'utf8');
  return missing;
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
  // P6 版本说明随引擎分发：init 幂等刷新 .harness/CHANGELOG.md 与 VERSION
  const engineInstallDir = join(root, '.harness');
  mkdirSync(engineInstallDir, { recursive: true });
  if (existsSync(join(KIT_ROOT, 'CHANGELOG.md'))) {
    copyFileSync(join(KIT_ROOT, 'CHANGELOG.md'), join(engineInstallDir, 'CHANGELOG.md'));
  }
  if (!existsSync(join(engineInstallDir, 'VERSION'))) {
    try {
      writeFileSync(join(engineInstallDir, 'VERSION'), `${readFileSync(join(KIT_ROOT, 'VERSION'), 'utf8').trim()}\n`);
    } catch {
      // kit 无 VERSION（源仓库布局差异）：留空，update 流程会补
    }
  }

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

  let agents = options.agents.length
    ? options.agents
    : (process.env.HARNESS_AGENTS ? process.env.HARNESS_AGENTS.split(',').map((item) => item.trim()).filter(Boolean) : null);
  if (!agents) {
    // 探测优先级：运行环境线索（新仓库常无任何配置目录）→ 目录存在性；猜错可 --agents 覆盖
    const detected = new Set();
    if (process.env.CLAUDECODE === '1') {
      detected.add('claude');
    }
    if (existsSync(join(root, '.claude'))) {
      detected.add('claude');
    }
    if (existsSync(join(root, '.codex'))) {
      detected.add('codex');
    }
    if (!detected.size) {
      console.error('[reqbank] 未检测到已配置的 agent（无 CLAUDECODE 环境线索、无 .claude/.codex 目录）。请用 --agents codex,claude 指定，或询问用户当前使用什么工具。');
      process.exit(2);
    }
    agents = [...detected];
    console.log(`[reqbank] agents 自动探测：${agents.join(',')}（可用 --agents 覆盖）`);
  }

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
        PreToolUse: [{
          matcher: 'Edit|Write|MultiEdit',
          hooks: [{ type: 'command', command: hookCommand('pre-critic'), timeout: 30 }]
        }],
        PostToolUse: [{
          matcher: 'Edit|Write|MultiEdit',
          hooks: [{ type: 'command', command: hookCommand('critic'), timeout: 60 }]
        }],
        Stop: [{ hooks: [{ type: 'command', command: hookCommand('finalize'), timeout: 60 }] }]
      };
      if (!existsSync(settingsPath)) {
        writeFileSync(settingsPath, `${JSON.stringify({ hooks: claudeHooks }, null, 2)}\n`);
        console.log('[reqbank] claude adapter → .claude/settings.json');
      } else {
        // 自动合并：只往 hooks 各事件数组追加缺失条目，其余字段原样保留；坏文件回退片段模式
        let settings = null;
        try {
          settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        } catch (error) {
          settings = null;
          console.warn(`[reqbank] ⚠ settings.json 无法解析（${error.message}）`);
        }
        const mergeTarget = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : null;
        if (mergeTarget) {
          const merged = mergeClaudeHooks(mergeTarget, claudeHooks);
          if (merged.changed) {
            copyFileSync(settingsPath, `${settingsPath}.bak`);
            writeFileSync(settingsPath, `${JSON.stringify({ ...mergeTarget, hooks: merged.hooks }, null, 2)}\n`);
            console.log(`[reqbank] claude settings 已自动合并钩子（原内容保留，备份于 .claude/settings.json.bak）`);
          } else {
            console.log('[reqbank] claude settings 已含全部钩子，无需修改');
          }
        } else {
          const snippetPath = join(root, '.claude', 'harness-hooks-snippet.json');
          writeFileSync(snippetPath, `${JSON.stringify(claudeHooks, null, 2)}\n`);
          console.warn(`[reqbank] 片段写入 ${snippetPath}——需手动合并进 settings.json 的 hooks 字段，合并前钩子不生效`);
        }
      }
    } else if (agent === 'grok') {
      console.log('[reqbank] grok 适配器为实验特性：请参考 README「多包仓库 / Grok 桥接」一节手动配置');
    } else {
      console.warn(`[reqbank] unknown agent: ${agent}`);
    }
  }

  const gitignoreEntries = [
    '.agentdoc/harness/hook-payloads/',
    '.agentdoc/harness/learning-log.jsonl',
    '.agentdoc/harness/update-check.json'
  ];
  if (agents.includes('claude')) {
    // Claude Code 个人权限白名单（点"始终允许"自动累积），按约定不进库，避免搭车提交与信息泄露
    gitignoreEntries.push('.claude/settings.local.json');
  }
  const gitignoreAdded = ensureGitignoreEntries(root, gitignoreEntries);
  if (gitignoreAdded.length) {
    console.log(`[reqbank] gitignore += ${gitignoreAdded.join(', ')}`);
  }

  // 安装即验证：成功标识 = "✓ check passed"；存量脚手架债务只警告，不阻断 init
  const selfCheck = spawnSync(process.execPath, [join(BIN_DIR, 'harness.mjs'), 'check'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HARNESS_PROJECT_ROOT: root }
  });
  if (selfCheck.status === 0) {
    console.log('[reqbank] ✓ check passed —— 安装完成');
  } else {
    console.warn('[reqbank] ⚠ check 报告问题（不影响安装，多为存量脚手架债务）：');
    const detail = `${selfCheck.stdout ?? ''}${selfCheck.stderr ?? ''}`.trim();
    if (detail) {
      console.warn(detail.split('\n').map((line) => `  ${line}`).join('\n'));
    }
  }

  console.log('\n下一步：');
  console.log('  1. 填充 .agentdoc/harness/global/index.md 的命中范围与标签');
  console.log(`  2. 用 reqbank scope "任务描述" 验证召回（当前 ${fresh ? '空脚手架，先沉淀第一条 REQ' : '已有记忆'}）`);
  console.log('  3. 提交前保持钩子静默通过；确定性冲突会被 Stop 拦截');
  console.log('  4. 冷启动沉淀：`reqbank mine` 考古候选 → inbox/ 人审入库；起草协议见 .agentdoc/harness/agent-guide.md');
  console.log('  5. 持续回流：`reqbank reflect` 把重复违规聚合成条款建议（可配 --transcript 消费会话纠错）');

  // P2 init --gate：把 gate 装配到提交/CI 时点（one engine, one verdict 的第二入口）
  if (options.gate) {
    const gitDir = join(root, '.git', 'hooks');
    const preCommitPath = join(gitDir, 'pre-commit');
    const preCommitBody = [
      '#!/bin/sh',
      '# reqbank gate (managed by reqbank init --gate) —— 手工改动会被下次 init --gate 覆盖',
      'node "$(git rev-parse --show-toplevel)/.harness/bin/harness.mjs" gate --staged',
      ''
    ].join('\n');
    try {
      mkdirSync(gitDir, { recursive: true });
      const existing = existsSync(preCommitPath) ? readFileSync(preCommitPath, 'utf8') : '';
      if (!existing || existing.includes('reqbank gate')) {
        writeFileSync(preCommitPath, preCommitBody);
        chmodSync(preCommitPath, 0o755);
        console.log('[reqbank] gate → .git/hooks/pre-commit（staged 改动过门禁才可提交）');
      } else {
        console.warn('[reqbank] ⚠ .git/hooks/pre-commit 已存在且非 reqbank 管理，未覆盖——请手工追加 gate --staged');
      }
      const workflowDir = join(root, '.github', 'workflows');
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(join(workflowDir, 'reqbank-gate.yml'), [
        'name: reqbank gate',
        'on:',
        '  push:',
        '  pull_request:',
        'jobs:',
        '  gate:',
        '    runs-on: ubuntu-latest',
        '    env:',
        '      HARNESS_GATE: "1"',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '        with:',
        '          fetch-depth: 0',
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: 22',
        '      - name: check --strict（结构 + lint + 追溯完整性）',
        '        run: node .harness/bin/harness.mjs check --strict',
        '      - name: gate --base origin/main（条款判决）',
        '        run: node .harness/bin/harness.mjs gate --base origin/${{ github.base_ref || \'main\' }}',
        '      - name: verify --all（全库 TC 命中即测）',
        '        run: node .harness/bin/harness.mjs verify --all',
        ''
      ].join('\n'));
      console.log('[reqbank] gate → .github/workflows/reqbank-gate.yml（check --strict + gate --base + verify --all）');
    } catch (error) {
      console.warn(`[reqbank] ⚠ gate 装配失败：${error.message}`);
    }
  }
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
      // P3 冻结基线健康：损坏的 gate-baseline.json 必须让 check 失败（fail-closed）
      const gateBaselinePath = join(harnessDir, 'gate-baseline.json');
      if (existsSync(gateBaselinePath)) {
        try {
          JSON.parse(readFileSync(gateBaselinePath, 'utf8'));
        } catch (error) {
          problems.push(`gate-baseline.json 无法解析（fail-closed）: ${error.message}`);
        }
      }
      const store = await import(join(ENGINE_DIR, 'lib', 'harness-store.mjs'));
      const lint = await import(join(ENGINE_DIR, 'lib', 'lint.mjs'));
      const requirements = store.loadAllRequirements({ includeInactive: true });
      const allTests = store.loadAllTests({ includeInactive: true });
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
      // P1 trace-integrity：引用完整性（悬挂/不对称=error）+ 铁律②与索引漂移（warning，--strict 升级）
      const trace = lint.lintTraceIntegrity({
        requirements,
        tests: allTests,
        moduleDirNames: modulesWithMeta.filter((module) => module.name !== 'global').map((module) => module.name),
        registeredModuleNames: store.listRegisteredModules()
      });
      for (const problem of trace.errors) {
        problems.push(`trace-integrity: ${problem}`);
      }
      let traceWarnings = 0;
      for (const warning of trace.warnings) {
        traceWarnings += 1;
        console.warn(`[reqbank] ⚠ trace-integrity: ${warning}`);
      }
      if (traceWarnings > 0 && strict) {
        problems.push(`${traceWarnings} 项追溯警告（--strict 模式下视为失败）`);
      }
      // P2 断言覆盖率：含禁止语义却无断言的条款——纯提示，不 strict 升级（渐进补齐）
      for (const hint of lint.lintAssertionCoverage(requirements)) {
        console.warn(`[reqbank] ⚠ ${hint}`);
      }
      // P3 生命周期：superseded 目标/成环（error）；gap/inferred 置信度（warning，gap 在 strict 下升级）
      const lifecycle = lint.lintLifecycle(requirements);
      for (const problem of lifecycle.errors) {
        problems.push(`lifecycle: ${problem}`);
      }
      for (const warning of lifecycle.warnings) {
        console.warn(`[reqbank] ⚠ lifecycle: ${warning}`);
      }
      if (lifecycle.warnings.some((w) => w.includes('gap 置信度')) && strict) {
        problems.push('存在 gap 置信度条款（--strict 模式下视为失败）——用 reqbank confirm 逐条人审');
      }
      // P3 漂移检测：命中路径在 git 追踪文件里零匹配 → 条款僵尸（warning；HARNESS_DRIFT_SKIP=1 跳过）
      if (!process.env.HARNESS_DRIFT_SKIP) {
        const gitRootDir = gitRoot();
        if (gitRootDir) {
          const ls = spawnSync('git', ['-C', gitRootDir, 'ls-files'], { encoding: 'utf8' });
          if (ls.status === 0) {
            const repoFiles = ls.stdout.split('\n').filter(Boolean);
            for (const warning of lint.lintDeadPaths({ modulesWithMeta, repoFiles })) {
              console.warn(`[reqbank] ⚠ ${warning}`);
            }
          }
        }
      }
      // 解析期完整性：重复 ID（error）/ 未识别段名（warning，可能是文档漂移）
      for (const parseWarning of store.consumeParseWarnings()) {
        if (parseWarning.kind === 'error') {
          problems.push(`${parseWarning.code}: ${parseWarning.message}`);
        } else {
          console.warn(`[reqbank] ⚠ ${parseWarning.code}: ${parseWarning.message}`);
        }
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
  // --vendor：P5 vendor 资产完整性（sha256 对照 VENDOR.json），不符 exit 1
  if (rest.includes('--vendor')) {
    const { verifyVendorAssets } = await import(join(ENGINE_DIR, 'lib', 'ast.mjs'));
    const vendorProblems = verifyVendorAssets();
    if (vendorProblems.length) {
      console.error(`[reqbank] vendor check failed (${vendorProblems.length}):`);
      for (const problem of vendorProblems) {
        console.error(`  - ${problem}`);
      }
      process.exit(1);
    }
    console.log('[reqbank] vendor check passed（AST 资产完整）');
    return;
  }
  console.log('[reqbank] check passed');
};

// P6 版本说明：CHANGELOG.md 随包分发（.harness/CHANGELOG.md，缺失回退 kit 根）。
const changelogPathAt = (root) => {
  const installed = join(root ?? '', '.harness', 'CHANGELOG.md');
  if (existsSync(installed)) return installed;
  const kit = join(KIT_ROOT, 'CHANGELOG.md');
  return existsSync(kit) ? kit : null;
};

const renderChangelogSection = (text, version) => {
  const lines = text.split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) sections.push(current);
      current = { version: line.slice(3).trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  if (!sections.length) return null;
  if (!version) return sections[0];
  return sections.find((section) => section.version.startsWith(version)) ?? null;
};

const cmdChangelog = async (rest = []) => {
  const root = projectRoot() ?? gitRoot();
  const path = changelogPathAt(root);
  if (!path) {
    console.error('[reqbank] CHANGELOG.md 不存在（kit 安装不完整或版本 < 0.11.0）');
    process.exit(2);
  }
  const showAll = rest.includes('--all');
  const versionArg = rest.find((arg) => !arg.startsWith('-'));
  const text = readFileSync(path, 'utf8');
  if (showAll) {
    console.log(text.trim());
    return;
  }
  const section = renderChangelogSection(text, versionArg);
  if (!section) {
    console.error(`[reqbank] 版本 ${versionArg ?? '(latest)'} 无对应记录（reqbank changelog --all 查看全部）`);
    process.exit(1);
  }
  console.log(section.lines.join('\n').trim());
};

// P5 reqbank lang：语法感知语言扩展（结构化断言 forbid-call/no-negate 的语法包管理）。
//   lang list                     内置语言 + 项目扩展
//   lang add <name> --ext .xx     从 npm 下载语法包 → brotli → .agentdoc/harness/vendor-lang/（随仓库共享）
//   lang remove <name>            移除项目扩展
// 来源固定 tree-sitter-wasms@0.1.13：与 vendored 运行时 web-tree-sitter@0.22.6 ABI 配对（NOTICE.md）。
const GRAMMAR_SOURCE = { package: 'tree-sitter-wasms', version: '0.1.13' };

const cmdLang = async (rest = []) => {
  const [action, name] = rest;
  const root = projectRoot() ?? gitRoot();
  if (!root) {
    console.error('[reqbank] no scaffold found (run init)');
    process.exit(2);
  }
  const vendorLangDir = join(root, '.agentdoc', 'harness', 'vendor-lang');
  const mapPath = join(vendorLangDir, 'lang-map.json');
  const readMap = () => {
    try {
      return JSON.parse(readFileSync(mapPath, 'utf8'));
    } catch {
      return {};
    }
  };
  const { builtinAstLanguages } = await import(join(ENGINE_DIR, 'lib', 'ast.mjs'));

  if (action === 'list') {
    const map = readMap();
    const byLanguage = {};
    for (const [ext, language] of Object.entries(map)) {
      (byLanguage[language] ??= []).push(ext);
    }
    console.log(`内置（随引擎 vendor）：${builtinAstLanguages().join(' ')}`);
    const extras = Object.keys(byLanguage);
    console.log(extras.length ? `项目扩展（vendor-lang/）：${extras.map((l) => `${l}(${byLanguage[l].join(' ')})`).join(' ')}` : '项目扩展：无（lang add <name> --ext .xx 按需扩展）');
    return;
  }

  if (action === 'add') {
    if (!name || !/^[a-z0-9_]+$/i.test(name)) {
      console.error('[reqbank] usage: reqbank lang add <grammar-name> --ext .xx[,.yy]');
      console.error('  grammar-name 为 tree-sitter 语法包名（如 kotlin、ruby、scala）');
      process.exit(2);
    }
    const extFlagIndex = rest.indexOf('--ext');
    const exts = extFlagIndex > -1 ? String(rest[extFlagIndex + 1] ?? '').split(',').map((e) => e.trim()).filter((e) => e.startsWith('.')) : [];
    if (!exts.length) {
      console.error('[reqbank] 需要 --ext 指定文件后缀（如 --ext .kt）');
      process.exit(2);
    }
    const member = `package/out/tree-sitter-${name}.wasm`;
    const url = `https://registry.npmjs.org/${GRAMMAR_SOURCE.package}/-/${GRAMMAR_SOURCE.package}-${GRAMMAR_SOURCE.version}.tgz`;
    const tmp = mkdtempSync(join(tmpdir(), 'reqbank-lang-'));
    try {
      const tgzPath = join(tmp, 'src.tgz');
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`下载失败 ${response.status}：${url}`);
      }
      writeFileSync(tgzPath, Buffer.from(await response.arrayBuffer()));
      // tar 直出成员到 stdout（跨平台：Windows 10+ 自带 bsdtar；无 shell 引号问题）
      const extracted = spawnSync('tar', ['-xOf', tgzPath, member], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
      if (extracted.status !== 0 || !extracted.stdout?.length) {
        throw new Error(`语法包 ${name} 不在 ${GRAMMAR_SOURCE.package}@${GRAMMAR_SOURCE.version}（tar 成员缺失）`);
      }
      const { brotliCompressSync, constants } = await import('node:zlib');
      mkdirSync(vendorLangDir, { recursive: true });
      const target = join(vendorLangDir, `tree-sitter-${name}.wasm.br`);
      writeFileSync(target, brotliCompressSync(extracted.stdout, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
      const map = readMap();
      for (const ext of exts) {
        map[ext] = name;
      }
      writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`);
      console.log(`[reqbank] lang add ${name} → ${target}`);
      console.log(`[reqbank] 后缀映射：${exts.map((e) => `${e} → ${name}`).join(', ')}（lang-map.json）`);
      console.log('[reqbank] vendor-lang/ 属于真源侧资产，建议随仓库提交以共享给协作者');
    } catch (error) {
      console.error(`[reqbank] lang add failed: ${error.message}`);
      process.exit(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }

  if (action === 'remove') {
    if (!name) {
      console.error('[reqbank] usage: reqbank lang remove <grammar-name>');
      process.exit(2);
    }
    const map = readMap();
    let removed = 0;
    for (const ext of Object.keys(map)) {
      if (map[ext] === name) {
        delete map[ext];
        removed += 1;
      }
    }
    rmSync(join(vendorLangDir, `tree-sitter-${name}.wasm.br`), { force: true });
    if (Object.keys(map).length) {
      writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`);
    } else {
      rmSync(mapPath, { force: true });
    }
    console.log(`[reqbank] lang remove ${name}（清除映射 ${removed} 项 + 语法包文件）`);
    return;
  }

  console.error('usage: reqbank lang <list|add|remove> [name] [--ext .xx]');
  process.exit(2);
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
    case 'lang':
      return cmdLang(rest);
    case 'update': {
      const options = parseArgs(rest);
      if (!options.positional.includes('--git') && !process.env.HARNESS_KIT_URL) {
        // npm 模式：从 registry 拉 latest 包，替换引擎层
        const root0 = projectRoot() ?? gitRoot() ?? process.cwd();
        const harnessDir0 = join(root0, '.harness');
        const before0 = existsSync(join(harnessDir0, 'VERSION')) ? readFileSync(join(harnessDir0, 'VERSION'), 'utf8').trim() : 'unknown';
        const tmp0 = mkdtempSync(join(tmpdir(), 'harness-npm-'));
        try {
          const view = spawnSync(`npm view ${PACKAGE_NAME} version`, { shell: true, encoding: 'utf8' });
          const latest = (view.stdout ?? '').trim();
          if (!latest) throw new Error('registry unreachable');
          if (latest === before0) {
            console.log(`[reqbank] 已是最新 ${latest}`);
            return;
          }
          const pack = spawnSync(`npm pack ${PACKAGE_NAME}@${latest} --pack-destination "${tmp0}"`, { shell: true, encoding: 'utf8' });
          const tgzName = (pack.stdout ?? '').trim().split('\n').filter(Boolean).at(-1);
          if (!tgzName) throw new Error('npm pack failed');
          spawnSync('tar', ['-xzf', join(tmp0, tgzName), '-C', tmp0]);
          const pkgDir = join(tmp0, 'package');
          rmSync(join(harnessDir0, 'engine'), { recursive: true, force: true });
          cpSync(join(pkgDir, 'engine'), join(harnessDir0, 'engine'), { recursive: true });
          cpSync(join(pkgDir, 'bin', 'harness.mjs'), join(harnessDir0, 'bin', 'harness.mjs'));
          cpSync(join(pkgDir, 'templates'), join(harnessDir0, 'templates'), { recursive: true });
          if (existsSync(join(pkgDir, 'CHANGELOG.md'))) {
            copyFileSync(join(pkgDir, 'CHANGELOG.md'), join(harnessDir0, 'CHANGELOG.md'));
          }
          writeFileSync(join(harnessDir0, 'VERSION'), `${latest}\n`);
          console.log(`[reqbank] updated ${before0} -> ${latest}（.agentdoc/harness 真源未动）`);
          const freshChangelog = existsSync(join(harnessDir0, 'CHANGELOG.md'))
            ? renderChangelogSection(readFileSync(join(harnessDir0, 'CHANGELOG.md'), 'utf8'), null)
            : null;
          if (freshChangelog) {
            console.log(`[reqbank] 本次变更：\n${freshChangelog.lines.join('\n').trim()}`);
          }
          console.log('[reqbank] 如需补齐 .gitignore 运行产物忽略与适配器渲染，可重跑 harness init（幂等）');
        } catch (error) {
          console.error(`[reqbank] npm update failed: ${error.message}；可改用 --git`);
          process.exitCode = 1;
        } finally {
          rmSync(tmp0, { recursive: true, force: true });
        }
        return;
      }
      const remote = process.env.HARNESS_KIT_URL ?? 'git@github.com:cirscn/reqbank.git';
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
        if (existsSync(join(kit, 'CHANGELOG.md'))) {
          copyFileSync(join(kit, 'CHANGELOG.md'), join(harnessDir, 'CHANGELOG.md'));
        }
        console.log(`[reqbank] updated ${before} -> ${version}（.agentdoc/harness 真源未动）`);
        console.log('[reqbank] 如需补齐 .gitignore 运行产物忽略与适配器渲染，可重跑 harness init（幂等）');
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
      const installed = existsSync(v) ? readFileSync(v, 'utf8').trim() : null;
      if (!installed) {
        console.log('(not installed)');
        return;
      }
      // P6：缓存优先显示 latest；网络失败静默回退只显示已装版本
      const { checkForUpdate } = await import(join(ENGINE_DIR, 'lib', 'update-check.mjs'));
      const check = await checkForUpdate({
        currentVersion: installed,
        cachePath: join(root, '.agentdoc', 'harness', 'update-check.json')
      });
      if (check.status === 'available') {
        console.log(`${installed}（latest ${check.latest}，运行 reqbank update 升级）`);
      } else {
        console.log(installed + (check.latest ? `（latest ${check.latest}）` : ''));
      }
      return;
    }
    case 'changelog':
      return cmdChangelog(rest);
    case 'smoke': {
      const smokePath = join(KIT_ROOT, 'scripts', 'smoke.mjs');
      const result = spawnSync(process.execPath, [smokePath], { stdio: 'inherit' });
      process.exit(result.status ?? 0);
      return;
    }
    case 'mine':
    case 'reflect':
    case 'status': {
      const entry = { mine: 'mine.mjs', reflect: 'reflect.mjs' }[command] ?? 'status.mjs';
      const result = spawnSync(process.execPath, [join(ENGINE_DIR, entry), ...rest], {
        stdio: 'inherit',
        env: { ...process.env, HARNESS_PROJECT_ROOT: process.env.HARNESS_PROJECT_ROOT }
      });
      process.exit(result.status ?? 0);
      return;
    }
    case 'confirm': {
      // P3 人审闭环：inferred/gap → confirmed（写索引第 5 列元数据，幂等）
      const root = projectRoot();
      if (!root) {
        console.error('[reqbank] no scaffold found (run init)');
        process.exit(2);
      }
      const target = rest[0] ?? '';
      const matchId = target.match(/^([\w-]+):(G?REQ-\d{3,})$/);
      if (!matchId) {
        console.error('[reqbank] usage: reqbank confirm <scope:REQ-id>');
        process.exit(2);
      }
      const store = await import(join(ENGINE_DIR, 'lib', 'harness-store.mjs'));
      const file = matchId[1] === 'global'
        ? join(root, '.agentdoc', 'harness', 'global', 'requirements.md')
        : join(root, '.agentdoc', 'harness', 'modules', matchId[1], 'requirements.md');
      if (!existsSync(file)) {
        console.error(`[reqbank] 未找到 ${file}`);
        process.exit(1);
      }
      const lines = readFileSync(file, 'utf8').split('\n');
      let done = false;
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].startsWith(`${matchId[2]} |`)) continue;
        const parts = lines[index].split('|').map((part) => part.trim());
        const meta = parts.length >= 5 ? store.parseIndexMeta(parts[3]) : null;
        if (meta) {
          const status = meta.status === 'superseded' ? `superseded>${meta.supersedes}` : meta.status;
          parts[3] = `${status}:confirmed${meta.enforcement === 'warn' ? ':warn' : ''}`;
        } else {
          parts.splice(3, 0, 'active:confirmed');
        }
        lines[index] = parts.join(' | ');
        done = true;
        break;
      }
      if (!done) {
        console.error(`[reqbank] ${file} 中未找到 ${matchId[2]} 的索引行`);
        process.exit(1);
      }
      writeFileSync(file, lines.join('\n'));
      console.log(`[reqbank] ✓ ${target} 置信度 → confirmed`);
      return;
    }
    case 'gate': {
      const result = spawnSync(process.execPath, [join(ENGINE_DIR, 'gate.mjs'), ...rest], {
        stdio: 'inherit',
        env: { ...process.env, HARNESS_PROJECT_ROOT: process.env.HARNESS_PROJECT_ROOT }
      });
      process.exit(result.status ?? 0);
      return;
    }
    case 'pre-critic':
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
      console.error('usage: reqbank <init|scope|check|doctor|verify|gate|status|confirm|mine|reflect|report|impact|smoke|update|lang|changelog|version|session-init|recall|pre-critic|critic|finalize> [args]');
      process.exit(command ? 2 : 0);
  }
};

main().catch((error) => {
  console.error(`[reqbank] fatal: ${error.message}`);
  // HARNESS_GATE=1（CI/门禁环境）：崩溃 fail-closed；默认（钩子/本地）维持 fail-open
  process.exit(process.env.HARNESS_GATE === '1' ? 2 : 0);
});
