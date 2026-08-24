#!/usr/bin/env node
// SessionStart hook: inject harness overall state at session start so codex
// knows what's already crystallized as REQ/TC, what's pending, and how the
// learning loop is wired.

import { listModulesWithMeta, listPendingModules, loadAllRequirements } from './lib/harness-store.mjs';
import { checkForUpdate } from './lib/update-check.mjs';
import { appendLog, appendPayloadSample, parseHookPayload, readHookStdin } from './lib/learning-log.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from './lib/repo-paths.mjs';

const installedVersionAt = (root) => {
  const versionPath = root ? join(root, '.harness', 'VERSION') : null;
  return versionPath && existsSync(versionPath) ? readFileSync(versionPath, 'utf8').trim() : null;
};

const main = async () => {
  const raw = await readHookStdin();
  const { input, parseError } = parseHookPayload(raw);
  const payloadSample = appendPayloadSample({ event: 'SessionStart', raw, input, parseError });
  if (parseError) {
    process.stderr.write(`[harness-hook session-init] stdin parse failed: ${parseError.message}\n`);
  }

  const builtModules = listModulesWithMeta();
  const pendingModules = listPendingModules();
  const allReqs = loadAllRequirements();
  const globalReqs = allReqs.filter((req) => req.scope === 'global');
  const moduleReqCounts = new Map();
  for (const req of allReqs) {
    if (req.scope !== 'global') {
      moduleReqCounts.set(req.scope, (moduleReqCounts.get(req.scope) ?? 0) + 1);
    }
  }

  const totalModuleReqs = [...moduleReqCounts.values()].reduce((sum, count) => sum + count, 0);
  const lines = [
    `Harness: ${builtModules.length} modules / ${totalModuleReqs} module REQ / ${globalReqs.length} global REQ / ${pendingModules.length} pending.`,
    'Recall is ID-first and only injected on hits; Stop hard-blocks deterministic harness failures only.'
  ];

  // P6 升级提醒：fail-open——任何失败（离线/CI/无安装态）都不影响会话启动
  let updateCheck = { status: 'unknown', current: null, latest: null, checkedVia: 'skipped' };
  try {
    const root = getProjectRoot();
    updateCheck = await checkForUpdate({
      currentVersion: installedVersionAt(root),
      cachePath: root ? join(root, '.agentdoc', 'harness', 'update-check.json') : null
    });
    if (updateCheck.status === 'available') {
      lines.push(`[reqbank] 新版本可用：${updateCheck.current} → ${updateCheck.latest}。运行 reqbank update 升级，reqbank changelog 查看变更。`);
    }
  } catch {
    updateCheck = { status: 'unknown', current: null, latest: null, checkedVia: 'error' };
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n')
    }
  };

  process.stdout.write(JSON.stringify(output));
  appendLog({
    event: 'SessionStart',
    session_id: input.session_id ?? null,
    source: input.source ?? null,
    payload_sample: payloadSample,
    parse_error: parseError?.message ?? null,
    built_modules: builtModules.map((module) => module.name),
    global_req_count: globalReqs.length,
    pending_module_count: pendingModules.length,
    update_check: { status: updateCheck.status, current: updateCheck.current, latest: updateCheck.latest, via: updateCheck.checkedVia },
    context_chars: lines.join('\n').length
  });
};

main().catch((err) => {
  process.stderr.write(`[harness-hook session-init] fatal: ${err.message}\n`);
  process.exit(0); // 不阻塞 codex；hook 失败仅影响附加上下文。
});
