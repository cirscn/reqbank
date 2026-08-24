// P6 升级提醒：SessionStart / version 命令共享的注册表版本检查。
// 设计约束：
//   - 永不阻塞、永不报错：网络失败/离线/CI 一律静默返回 unknown（fail-open）
//   - 24h 本地缓存：每会话最多一次注册表请求，缓存命中零网络
//   - HARNESS_SKIP_UPDATE_CHECK=1 彻底关闭（CI/敏感环境）
//   - fetchImpl/now 可注入：与 llm-critic 的 callProvider 同款可测性设计

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const REGISTRY_URL = 'https://registry.npmjs.org/@cirscn%2Freqbank';
const FETCH_TIMEOUT_MS = 2500;

// 语义化版本比较：只比 x.y.z 数字段（pre-release 后缀按忽略处理，本包不发 pre）
export const compareSemver = (a, b) => {
  const parse = (v) => String(v ?? '').replace(/^v/, '').split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [aMajor, aMinor, aPatch] = parse(a);
  const [bMajor, bMinor, bPatch] = parse(b);
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
  return 0;
};

const readCache = (cachePath, now, ttlMs) => {
  if (!cachePath || !existsSync(cachePath)) return null;
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (typeof cached.checkedAt !== 'number' || typeof cached.latest !== 'string') return null;
    return now() - cached.checkedAt <= ttlMs ? cached : null;
  } catch {
    return null;
  }
};

/**
 * 返回 { status: 'available'|'latest'|'unknown'|'disabled', current, latest, checkedVia }
 * status=available 表示 registry 有更新版本；其余情况不产生提醒。
 */
export const checkForUpdate = async ({
  currentVersion,
  fetchImpl,
  now = Date.now,
  cachePath = null,
  ttlMs = UPDATE_CHECK_TTL_MS,
  registryUrl = REGISTRY_URL
}) => {
  const current = String(currentVersion ?? '').trim();
  if (!current) {
    return { status: 'unknown', current: null, latest: null, checkedVia: 'no-current-version' };
  }
  if (process.env.HARNESS_SKIP_UPDATE_CHECK === '1') {
    return { status: 'disabled', current, latest: null, checkedVia: 'env' };
  }
  const fetcher = fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!fetcher) {
    return { status: 'unknown', current, latest: null, checkedVia: 'no-fetch' };
  }

  const cached = readCache(cachePath, now, ttlMs);
  if (cached) {
    return {
      status: compareSemver(current, cached.latest) < 0 ? 'available' : 'latest',
      current,
      latest: cached.latest,
      checkedVia: 'cache'
    };
  }

  try {
    const response = await fetcher(registryUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      return { status: 'unknown', current, latest: null, checkedVia: `registry-${response.status}` };
    }
    const data = await response.json();
    const latest = data?.['dist-tags']?.latest;
    if (typeof latest !== 'string' || !latest) {
      return { status: 'unknown', current, latest: null, checkedVia: 'registry-shape' };
    }
    if (cachePath) {
      try {
        writeFileSync(cachePath, `${JSON.stringify({ checkedAt: now(), latest }, null, 2)}\n`);
      } catch {
        // 缓存写失败（只读目录等）：仅影响下次多一次请求，静默
      }
    }
    return {
      status: compareSemver(current, latest) < 0 ? 'available' : 'latest',
      current,
      latest,
      checkedVia: 'registry'
    };
  } catch {
    return { status: 'unknown', current, latest: null, checkedVia: 'network' };
  }
};
