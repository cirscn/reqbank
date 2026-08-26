import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = join('.agentdoc', 'harness');

// Windows ESM：动态 import 的 specifier 按 URL 解析，绝对路径必须先转 file://——
// 盘符裸路径（D:\x.mjs）会被解析成协议，抛 ERR_INVALID_URL_SCHEME（Received protocol 'd:'）。
export const dynamicImport = (path) => import(pathToFileURL(path).href);

/**
 * 项目根解析（按优先级）：
 * 1. 环境变量 HARNESS_PROJECT_ROOT
 * 2. 从 cwd 向上查找包含 .agentdoc/harness 的目录
 * 3. git toplevel（存在 .agentdoc/harness 时）
 *
 * 找不到时抛错——由调用方决定 fail-open 还是提示 init。
 */
const findRootByMarker = (startDir) => {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, MARKER))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
};

const findGitRoot = (startDir) => {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
};

let cached = undefined;

export const getProjectRoot = () => {
  if (cached !== undefined) {
    return cached;
  }
  const startDir = process.env.HARNESS_INIT_CWD || process.cwd();
  cached =
    (process.env.HARNESS_PROJECT_ROOT && resolve(process.env.HARNESS_PROJECT_ROOT))
    || findRootByMarker(startDir)
    || (() => {
      const gitRoot = findGitRoot(startDir);
      return gitRoot && existsSync(join(gitRoot, MARKER)) ? gitRoot : null;
    })();
  if (!cached) {
    throw new Error('[harness] project root not found — run `node .harness/bin/harness.mjs init` first, or set HARNESS_PROJECT_ROOT');
  }
  return cached;
};

export const repoPath = (...segments) => join(getProjectRoot(), ...segments);
