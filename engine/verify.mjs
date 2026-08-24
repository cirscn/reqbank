#!/usr/bin/env node
// harness verify —— 把"命中即测"机械化：收集本回合命中的 TC，真实执行其 V 字段验证命令。
//
// 用法：
//   node verify.mjs                          # 默认：learning-log 里最近一个有召回的回合
//   node verify.mjs --turn <turn_id>         # 指定回合
//   node verify.mjs --tc <scope:TC-001>      # 直接指定条款（可多个）
//
// 行为：
//   - 从 TC 的 V 字段提取可执行命令（反引号内的命令即执行，不限语言生态）
//   - 危险命令确定性拒绝（fail-closed，计入失败）：拦截误写/误执行的破坏性命令；
//     这是 best-effort 不是沙箱，确认安全可设 HARNESS_VERIFY_ALLOW_UNSAFE=1 越过
//   - 顺序执行，逐条写 learning-log（event: verify）
//   - 任一失败 → exit 1；无可执行命令 → exit 0 + skipped 说明

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot, repoPath } from './lib/repo-paths.mjs';
import { loadAllTests } from './lib/harness-store.mjs';

const LOG_PATH = () => repoPath('.agentdoc', 'harness', 'learning-log.jsonl');

const readLog = () => {
  const path = LOG_PATH();
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

const lastTurnWithRecall = (events) => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event === 'UserPromptSubmit' && event.turn_id && (event.recall_hits?.length || event.recall_ids?.length)) {
      return event.turn_id;
    }
  }
  return null;
};

const collectTcIds = (events, turnId) => {
  const ids = new Set();
  for (const event of events) {
    if (turnId && event.turn_id !== turnId) continue;
    for (const key of ['recall_hits', 'recall_ids', 'matched_ids', 'weak_ids']) {
      for (const id of event[key] ?? []) {
        if (/TC-\d{3}$/.test(id)) {
          ids.add(id);
        }
      }
    }
  }
  return [...ids];
};

const extractCommands = (verifyText) => {
  const commands = [];
  for (const match of String(verifyText ?? '').matchAll(/`([^`]+)`/g)) {
    const command = match[1].trim();
    if (command) {
      commands.push(command);
    }
  }
  return commands;
};

// 危险模式清单：目标是拦"误写/误执行"级别的破坏，不是对抗刻意绕过（变量拼接、
// base64 中转等绕过手段必然存在）——真要跑不可信内容请放进容器。模式命中即拒绝执行。
const UNSAFE_CHECKS = [
  ['rm 递归强删', (cmd) => /\brm\b/.test(cmd) && /(^|\s)-[a-zA-Z]*r/.test(cmd) && /(^|\s)-[a-zA-Z]*f/.test(cmd)],
  ['提权执行', (cmd) => /\b(sudo|doas)\b/.test(cmd)],
  ['格式化文件系统', (cmd) => /\bmkfs(\.\w+)?\b/.test(cmd)],
  ['dd 写裸设备', (cmd) => /\bdd\b[^|]*\bof=\/dev\//.test(cmd)],
  ['重定向写裸设备', (cmd) => />\s*\/dev\/(sd|disk|nvme|mmc)/.test(cmd)],
  ['关机/重启', (cmd) => /\b(shutdown|reboot|halt|poweroff)\b/.test(cmd)],
  ['下载内容直接进 shell', (cmd) => /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(cmd)],
  ['fork 炸弹', (cmd) => /:\s*\(\)\s*\{\s*:\s*\|/.test(cmd)],
  ['递归改权限到系统路径', (cmd) => /\bch(mod|own)\s+-R\b[^|]*\s(~|\/(?!tmp))/.test(cmd)]
];

const findUnsafe = (command) => UNSAFE_CHECKS.find(([, test]) => test(command))?.[0];

const main = async () => {
  const args = process.argv.slice(2);
  let turnId = null;
  const explicitTcs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--turn') {
      index += 1;
      turnId = args[index];
    } else if (args[index] === '--tc') {
      index += 1;
      explicitTcs.push(args[index]);
    }
  }

  const root = getProjectRoot();
  const allTests = loadAllTests();
  const testById = new Map(allTests.map((record) => [`${record.scope}:${record.id}`, record]));

  let tcIds = [...explicitTcs];
  if (!tcIds.length) {
    const events = existsSync(LOG_PATH()) ? readLog() : [];
    const target = turnId ?? lastTurnWithRecall(events);
    tcIds = collectTcIds(events, target).map((shortId) => {
      // 回合日志里的 id 可能带 scope 前缀，也可能不带——按全库解析
      if (testById.has(shortId)) return shortId;
      const bare = shortId.split(':').pop();
      const found = allTests.find((record) => record.id === bare);
      return found ? `${found.scope}:${found.id}` : shortId;
    });
    if (!tcIds.length) {
      console.log(`[harness verify] 回合 ${target ?? '(none)'} 无命中 TC，无需执行`);
      return;
    }
  }

  console.log(`[harness verify] 待执行 ${tcIds.length} 条`);
  let failures = 0;
  for (const fullId of tcIds) {
    const record = testById.get(fullId);
    if (!record) {
      console.warn(`  ? ${fullId}: 未找到 TC 定义，跳过`);
      continue;
    }
    const commands = extractCommands(record.verify?.[0] ?? record.verify?.join(' '));
    if (!commands.length) {
      console.log(`  ~ ${fullId}: V 字段无可自动执行命令（人工项）→ ${record.mustVerify?.slice(0, 60) ?? ''}`);
      continue;
    }
    for (const command of commands) {
      if (!process.env.HARNESS_VERIFY_ALLOW_UNSAFE) {
        const unsafeLabel = findUnsafe(command);
        if (unsafeLabel) {
          failures += 1;
          console.error(`  ⛔ ${fullId}: 命中危险模式（${unsafeLabel}），拒绝执行：${command}`);
          console.error('     确认安全后设 HARNESS_VERIFY_ALLOW_UNSAFE=1 重跑');
          continue;
        }
      }
      process.stdout.write(`  ▶ ${fullId}: ${command}\n`);
      const result = spawnSync(command, {
        cwd: root,
        encoding: 'utf8',
        shell: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 300000
      });
      const ok = result.status === 0;
      if (!ok) {
        failures += 1;
        process.stdout.write(`    ✗ exit ${result.status}\n${(result.stderr || result.stdout || '').slice(-800)}\n`);
      } else {
        process.stdout.write('    ✓\n');
      }
    }
  }

  if (failures > 0) {
    console.error(`[harness verify] ${failures} 条验证命令失败`);
    process.exit(1);
  }
  console.log('[harness verify] 全部通过');
};

main().catch((error) => {
  console.error(`[harness verify] fatal: ${error.message}`);
  process.exit(0);
});
