import { getDb } from "./db";

export interface FileTotals {
  path: string;
  added: number;
  removed: number;
  growth: number;
  churn: number;
}

export interface MetricTotals {
  added: number;
  removed: number;
  growth: number;
  churn: number;
}

/**
 * File metrics summed over the ingested commit set H-bar (all non-merge commits
 * reachable from the ref): l+, l-, growth d = l+ - l-, churn l = l+ + l-.
 */
export function queryFileTotals(repoId: number): FileTotals[] {
  return getDb()
    .prepare(
      `SELECT
         path,
         SUM(added)                  AS added,
         SUM(removed)                AS removed,
         SUM(added) - SUM(removed)   AS growth,
         SUM(added) + SUM(removed)   AS churn
       FROM file_deltas
       WHERE repo_id = ?
       GROUP BY path
       ORDER BY churn DESC, path ASC`,
    )
    .all(repoId) as FileTotals[];
}

export function summarizeTotals(files: FileTotals[]): MetricTotals {
  return files.reduce(
    (acc, file) => ({
      added: acc.added + file.added,
      removed: acc.removed + file.removed,
      growth: acc.growth + file.growth,
      churn: acc.churn + file.churn,
    }),
    { added: 0, removed: 0, growth: 0, churn: 0 },
  );
}
