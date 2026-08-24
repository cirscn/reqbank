// 结构影响面扩展（可选层）：若项目存在 mex 风格的代码图谱（.mex/graph.db，node:sqlite 只读），
// 召回时把「改动文件的调用邻居」并入候选路径——改共享 util 时，下游模块的 REQ 一并浮出。
// 图不存在 / 查询失败一律返回空集（fail-open，零依赖退化）。

import { existsSync } from 'node:fs';
import { join } from 'node:path';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Node < 22.5 无内置 sqlite：保持静默降级
}

const GRAPH_RELATIVE = join('.mex', 'graph.db');

/**
 * @returns {{ expanded: string[], source: 'mex-graph'|null }}
 *   expanded: 与改动文件存在一条调用边关系的其他文件路径（platform 相对），按连接强度降序。
 */
export const expandPathsViaGraph = ({ rootPath, changedPaths, maxNeighbors = 8 }) => {
  if (!DatabaseSync || !changedPaths?.length) {
    return { expanded: [], source: null };
  }
  const dbPath = join(rootPath, GRAPH_RELATIVE);
  if (!existsSync(dbPath)) {
    return { expanded: [], source: null };
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const scores = new Map();
    const statement = db.prepare(`
      SELECT s.file_path AS src_fp, t.file_path AS dst_fp
      FROM edges e
      JOIN nodes s ON s.id = e.source
      JOIN nodes t ON t.id = e.target
      WHERE t.file_path = ? OR s.file_path = ?
    `);
    for (const changedPath of changedPaths) {
      let rows;
      try {
        rows = statement.all(changedPath, changedPath);
      } catch {
        continue;
      }
      for (const row of rows ?? []) {
        const neighbor = row.src_fp === changedPath ? row.dst_fp : row.src_fp;
        if (!neighbor || neighbor === changedPath) continue;
        scores.set(neighbor, (scores.get(neighbor) ?? 0) + 1);
      }
    }
    const expanded = [...scores.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, maxNeighbors)
      .map(([filePath]) => filePath.replaceAll('\\', '/'));
    return { expanded, source: 'mex-graph' };
  } catch {
    return { expanded: [], source: null };
  }
};

/** 是否启用影响面扩展：HARNESS_IMPACT=off 显式关闭；默认自动（有图则用）。 */
export const impactEnabled = (env = process.env) => env.HARNESS_IMPACT !== 'off';
