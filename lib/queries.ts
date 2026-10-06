import { getDb } from "./db";
import type { ResolvedCommitSetFilter } from "./commitSet";
import { ROOT_DIR } from "./rollup";

export interface FileTotals {
  path: string;
  added: number;
  removed: number;
  growth: number;
  churn: number;
}

export interface DirectoryTotals {
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

/**
 * Directory metrics over the ingested commit set H-bar. The rows are the
 * recursive rollup materialized at ingest: each directory (root "." included)
 * already carries the deltas of every file below it.
 */
export function queryDirectoryTotals(repoId: number): DirectoryTotals[] {
  return getDb()
    .prepare(
      `SELECT
         path,
         SUM(added)                  AS added,
         SUM(removed)                AS removed,
         SUM(added) - SUM(removed)   AS growth,
         SUM(added) + SUM(removed)   AS churn
       FROM dir_deltas
       WHERE repo_id = ?
       GROUP BY path
       ORDER BY path ASC`,
    )
    .all(repoId) as DirectoryTotals[];
}

/**
 * Repository metrics = directory metrics at the root of the commit tree,
 * read from the materialized root (".") rows. Zeroes when a repository was
 * ingested before directory rollups existed, or has no measurable deltas.
 */
export function queryRepoTotals(repoId: number): MetricTotals {
  const row = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(added), 0)   AS added,
         COALESCE(SUM(removed), 0) AS removed
       FROM dir_deltas
       WHERE repo_id = ? AND path = ?`,
    )
    .get(repoId, ROOT_DIR) as { added: number; removed: number };
  return {
    added: row.added,
    removed: row.removed,
    growth: row.added - row.removed,
    churn: row.added + row.removed,
  };
}

// ---------------------------------------------------------------------------
// Commit-set metrics over a filtered H (the brief's section 2.4)
// ---------------------------------------------------------------------------

export interface CommitSetTotals {
  added: number;
  removed: number;
  growth: number;
  churn: number;
  /** n_{H,o}: the number of commits h ∈ H with churn λ(h,o) > 0. */
  modifications: number;
  /** η = n / |H| — 0 when |H| = 0. */
  modFrequency: number;
  /** ρ = λ / |H| — 0 when |H| = 0. */
  churnRate: number;
}

export interface CommitSetObjectTotals extends CommitSetTotals {
  path: string;
}

export interface CommitSetMetrics {
  /** |H| — the number of commits in the set. */
  size: number;
  /** Repository metrics = the commit-set metrics of the root directory. */
  repo: CommitSetTotals;
  files: CommitSetObjectTotals[];
  directories: CommitSetObjectTotals[];
}

export interface CommitPickerRow {
  sha: string;
  author_name: string;
  committer_ts: number;
}

/**
 * The SQL condition selecting H from the commits table (aliased c):
 * - manual list: an explicit sha IN (...) over any subset of H-bar; an empty
 *   selection must yield the empty set, not "everything"
 * - period: i ≤ committer_ts < j with either bound optional (H_t / H_{i,j})
 * - all: every commit of H-bar
 */
function commitSetCondition(filter: ResolvedCommitSetFilter): {
  sql: string;
  params: Array<number | string>;
} {
  if (filter.mode === "commits") {
    if (filter.shas.length === 0) return { sql: "0 = 1", params: [] };
    return {
      sql: `c.sha IN (${filter.shas.map(() => "?").join(", ")})`,
      params: filter.shas,
    };
  }
  const conds: string[] = [];
  const params: number[] = [];
  if (filter.mode === "period") {
    if (filter.fromTs !== undefined) {
      conds.push("c.committer_ts >= ?");
      params.push(filter.fromTs);
    }
    if (filter.toTs !== undefined) {
      conds.push("c.committer_ts < ?");
      params.push(filter.toTs);
    }
  }
  return { sql: conds.join(" AND ") || "1 = 1", params };
}

export function zeroCommitSetTotals(): CommitSetTotals {
  return {
    added: 0,
    removed: 0,
    growth: 0,
    churn: 0,
    modifications: 0,
    modFrequency: 0,
    churnRate: 0,
  };
}

function toCommitSetTotals(
  row: { added: number; removed: number; modifications: number },
  size: number,
): CommitSetTotals {
  const churn = row.added + row.removed;
  return {
    added: row.added,
    removed: row.removed,
    growth: row.added - row.removed,
    churn,
    modifications: row.modifications,
    modFrequency: size === 0 ? 0 : row.modifications / size,
    churnRate: size === 0 ? 0 : churn / size,
  };
}

/**
 * Commit-set metrics over H: for every file and directory the sums l+, l−, δ
 * and λ of all h ∈ H, the modifications n (commits whose churn on the object
 * is > 0 — a pure rename's +0/−0 row is not a modification) and the derived
 * ratios η = n/|H| and ρ = λ/|H| (both 0 when |H| = 0). File rows come from
 * the per-commit deltas; directory rows from the rollup materialized at
 * ingest; the root (".") row is the repository metric.
 */
export function queryCommitSetMetrics(
  repoId: number,
  filter: ResolvedCommitSetFilter,
): CommitSetMetrics {
  const db = getDb();
  const condition = commitSetCondition(filter);

  const sizeRow = db
    .prepare(`SELECT COUNT(*) AS n FROM commits c WHERE c.repo_id = ? AND ${condition.sql}`)
    .get(repoId, ...condition.params) as { n: number };
  const size = sizeRow.n;

  const objectRows = (
    table: "file_deltas" | "dir_deltas",
    order: string,
  ): Array<{ path: string; added: number; removed: number; modifications: number }> =>
    db
      .prepare(
        `SELECT
           x.path AS path,
           SUM(x.added) AS added,
           SUM(x.removed) AS removed,
           SUM(CASE WHEN x.added + x.removed > 0 THEN 1 ELSE 0 END) AS modifications
         FROM ${table} x
         JOIN commits c ON c.id = x.commit_id
         WHERE x.repo_id = ? AND ${condition.sql}
         GROUP BY x.path
         ORDER BY ${order}`,
      )
      .all(repoId, ...condition.params) as Array<{
      path: string;
      added: number;
      removed: number;
      modifications: number;
    }>;

  const files = objectRows("file_deltas", "(SUM(x.added) + SUM(x.removed)) DESC, x.path ASC").map(
    (row) => ({ path: row.path, ...toCommitSetTotals(row, size) }),
  );
  const directories = objectRows("dir_deltas", "x.path ASC").map((row) => ({
    path: row.path,
    ...toCommitSetTotals(row, size),
  }));

  return {
    size,
    repo: rootCommitSetTotals(directories, size),
    files,
    directories,
  };
}

/** Repository metrics = the root directory's commit-set metrics (path-free). */
function rootCommitSetTotals(
  directories: CommitSetObjectTotals[],
  size: number,
): CommitSetTotals {
  const root = directories.find((row) => row.path === ROOT_DIR);
  return root === undefined ? zeroCommitSetTotals() : toCommitSetTotals(root, size);
}

/**
 * Resolves the manual picker's tokens to commits of this repository: an exact
 * sha (case-insensitive) or a unique prefix (as printed by `git log
 * --oneline`). Anything else — no match or an ambiguous prefix — is reported
 * as unknown and ignored, so the manual list stays a subset of H-bar.
 */
export function resolveCommitShas(
  repoId: number,
  tokens: string[],
): { shas: string[]; unknown: string[] } {
  const all = (getDb().prepare("SELECT sha FROM commits WHERE repo_id = ?").all(repoId) as Array<{
    sha: string;
  }>).map((row) => row.sha);

  const shas: string[] = [];
  const unknown: string[] = [];
  for (const token of tokens) {
    const wanted = token.toLowerCase();
    const exact = all.find((sha) => sha === wanted);
    if (exact !== undefined) {
      if (!shas.includes(exact)) shas.push(exact);
      continue;
    }
    const matches = all.filter((sha) => sha.startsWith(wanted));
    if (matches.length === 1) {
      shas.push(matches[0]);
      continue;
    }
    unknown.push(token);
  }
  return { shas, unknown };
}

/** The commits of H-bar for the manual picker: newest first. */
export function queryCommitPickerRows(repoId: number): CommitPickerRow[] {
  return getDb()
    .prepare(
      `SELECT sha, author_name, committer_ts
       FROM commits
       WHERE repo_id = ?
       ORDER BY committer_ts DESC, sha DESC`,
    )
    .all(repoId) as CommitPickerRow[];
}
