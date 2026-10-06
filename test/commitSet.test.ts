import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCommitSetFilter, type ResolvedCommitSetFilter } from "../lib/commitSet.ts";
import { makeFixtureRepo } from "./makeFixtureRepo.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rat-commitset-"));
process.env.RAT_DB_PATH = path.join(tmpRoot, "test.db");

const repoDir = path.join(tmpRoot, "fixture-repo");
makeFixtureRepo(repoDir);

// The fixture commits are scripted with fixed committer dates: the commit()
// helper stamps them BASE + i*3600 by *call order* — c1..c10 use indices
// 1..10 and, since the merge commit never calls commit(), c12..c19 use
// indices 11..18. The merge itself carries a real-time date and is excluded
// from H-bar anyway.
const BASE = 1700000000;
const ts = (commitNumber: number) =>
  BASE + (commitNumber <= 10 ? commitNumber : commitNumber - 1) * 3600;

let repoId = 0;

const ALL: ResolvedCommitSetFilter = { mode: "all", shas: [] };
const period = (from?: number, to?: number): ResolvedCommitSetFilter => ({
  mode: "period",
  fromTs: from,
  toTs: to,
  shas: [],
});

async function shaOf(commitIndex: number): Promise<string> {
  const { getDb } = await import("../lib/db.ts");
  const row = getDb()
    .prepare("SELECT sha FROM commits WHERE repo_id = ? AND committer_ts = ?")
    .get(repoId, ts(commitIndex)) as { sha: string } | undefined;
  assert.ok(row, `fixture commit c${commitIndex} missing from the commits table`);
  return row.sha;
}

async function manual(...commitIndexes: number[]): Promise<ResolvedCommitSetFilter> {
  const { resolveCommitShas } = await import("../lib/queries.ts");
  const tokens = await Promise.all(commitIndexes.map(shaOf));
  const { shas } = resolveCommitShas(repoId, tokens);
  return { mode: "commits", shas };
}

test("parseCommitSetFilter reads mode, period bounds and sha tokens", () => {
  const parsed = parseCommitSetFilter(
    new URLSearchParams("mode=period&from=1700003600&to=2024-11-14T22:13&commit=abc&shas=def%20ghi%2Cjkl"),
  );
  assert.equal(parsed.mode, "period");
  assert.equal(parsed.fromTs, 1700003600);
  assert.equal(parsed.toTs, Date.parse("2024-11-14T22:13Z") / 1000, "datetime-local read as UTC");
  assert.deepEqual(parsed.shaTokens, ["abc", "def", "ghi", "jkl"]);

  const empty = parseCommitSetFilter(new URLSearchParams(""));
  assert.equal(empty.mode, "all");
  assert.equal(empty.fromTs, undefined);
  assert.equal(empty.toTs, undefined);
  assert.deepEqual(empty.shaTokens, []);

  assert.equal(parseCommitSetFilter(new URLSearchParams("mode=bogus")).mode, "all");
  assert.equal(parseCommitSetFilter(new URLSearchParams("from=not-a-date")).fromTs, undefined);
  assert.equal(
    parseCommitSetFilter(new URLSearchParams("mode=commits&shas=%20%2C")).shaTokens.length,
    0,
    "separator-only paste yields no tokens",
  );
});

test("commit-set metrics over H-bar equal the legacy full-history totals", async () => {
  const { ingestFromDirectory } = await import("../lib/git/ingest.ts");
  const {
    queryCommitSetMetrics,
    queryDirectoryTotals,
    queryFileTotals,
    queryRepoTotals,
  } = await import("../lib/queries.ts");

  repoId = ingestFromDirectory(repoDir, { name: "commit-set", sourceKind: "zip" }).repoId;
  const metrics = queryCommitSetMetrics(repoId, ALL);
  assert.equal(metrics.size, 18, "H-bar: the 18 non-merge commits (merge excluded)");

  const plain = (rows: ReturnType<typeof queryFileTotals>) =>
    rows.map(({ path, added, removed, growth, churn }) => ({ path, added, removed, growth, churn }));
  assert.deepEqual(plain(metrics.files), queryFileTotals(repoId));
  assert.deepEqual(
    plain(metrics.directories),
    queryDirectoryTotals(repoId).map((d) => ({
      path: d.path,
      added: d.added,
      removed: d.removed,
      growth: d.growth,
      churn: d.churn,
    })),
  );
  assert.deepEqual(
    {
      added: metrics.repo.added,
      removed: metrics.repo.removed,
      growth: metrics.repo.growth,
      churn: metrics.repo.churn,
    },
    queryRepoTotals(repoId),
  );

  // n = commits with λ(root) > 0: every commit except the pure renames
  // (c3, c19) and the binary-only commits (c7, c17).
  assert.equal(metrics.repo.modifications, 14);
  assert.equal(metrics.repo.modFrequency, 14 / 18);
  assert.equal(metrics.repo.churnRate, 89 / 18);
});

test("period filter H_{i,j} = {i ≤ committer_ts < j} over the scripted window", async () => {
  const { queryCommitSetMetrics } = await import("../lib/queries.ts");

  // i = one second before c12's committer date, j = c17's committer date.
  // j's exclusivity excludes c17, so H is exactly c12..c16.
  const metrics = queryCommitSetMetrics(repoId, period(ts(12) - 1, ts(17)));
  assert.equal(metrics.size, 5);
  assert.deepEqual(metrics.repo, {
    added: 13,
    removed: 7,
    growth: 6,
    churn: 20,
    modifications: 5,
    modFrequency: 1,
    churnRate: 4,
  });

  const files = Object.fromEntries(metrics.files.map((f) => [f.path, f]));
  assert.equal(metrics.files.length, 4);
  assert.deepEqual(files["src/app/main.txt"], {
    path: "src/app/main.txt",
    added: 5,
    removed: 5,
    growth: 0,
    churn: 10,
    modifications: 2, // c12 (+5) and c14 (−5) both touch it
    modFrequency: 0.4,
    churnRate: 2,
  });
  assert.deepEqual(files["src/lib/helper.txt"], {
    path: "src/lib/helper.txt",
    added: 5,
    removed: 1,
    growth: 4,
    churn: 6,
    modifications: 2,
    modFrequency: 0.4,
    churnRate: 1.2,
  });
  assert.deepEqual(files["src/support/helper.txt"], {
    path: "src/support/helper.txt",
    added: 1,
    removed: 1,
    growth: 0,
    churn: 2,
    modifications: 1,
    modFrequency: 0.2,
    churnRate: 0.4,
  });
  assert.deepEqual(files["deep/one/two/leaf.txt"], {
    path: "deep/one/two/leaf.txt",
    added: 2,
    removed: 0,
    growth: 2,
    churn: 2,
    modifications: 1,
    modFrequency: 0.2,
    churnRate: 0.4,
  });

  const dirs = Object.fromEntries(metrics.directories.map((d) => [d.path, d]));
  // c15 adds nothing below src/, so src sees only c12, c13, c14, c16.
  assert.deepEqual(dirs["src"], {
    path: "src",
    added: 11,
    removed: 7,
    growth: 4,
    churn: 18,
    modifications: 4,
    modFrequency: 0.8,
    churnRate: 3.6,
  });
  const { path: rootPath, ...rootRow } = dirs["."];
  assert.equal(rootPath, ".");
  assert.deepEqual(
    rootRow,
    metrics.repo,
    "repository metrics are the root directory's commit-set metrics",
  );
});

test("H_t (from-only period) counts zero-churn rename rows as non-modifications", async () => {
  const { queryCommitSetMetrics } = await import("../lib/queries.ts");

  const metrics = queryCommitSetMetrics(repoId, period(ts(14), undefined));
  assert.equal(metrics.size, 6); // c14..c19 (c17 measures nothing, c19 is a pure rename)
  assert.deepEqual(metrics.repo, {
    added: 5,
    removed: 6,
    growth: -1,
    churn: 11,
    modifications: 4, // c14, c15, c16, c18 — not c17 (binary rename) or c19 (pure rename)
    modFrequency: 4 / 6,
    churnRate: 11 / 6,
  });

  const files = Object.fromEntries(metrics.files.map((f) => [f.path, f]));
  assert.deepEqual(files['qu"ote.txt'], {
    path: 'qu"ote.txt',
    added: 2,
    removed: 0,
    growth: 2,
    churn: 2,
    modifications: 1,
    modFrequency: 1 / 6,
    churnRate: 2 / 6,
  });
  // c19 renames qu"ote.txt onto back\slash.txt (+0 −0): the row exists on the
  // new path but must not count as a modification.
  assert.deepEqual(files["back\\slash.txt"], {
    path: "back\\slash.txt",
    added: 0,
    removed: 0,
    growth: 0,
    churn: 0,
    modifications: 0,
    modFrequency: 0,
    churnRate: 0,
  });
});

test("to-only period — j exclusive upper bound", async () => {
  const { queryCommitSetMetrics } = await import("../lib/queries.ts");

  const metrics = queryCommitSetMetrics(repoId, period(undefined, ts(6)));
  assert.equal(metrics.size, 5); // c1..c5; the deletion of c.txt (c6) is excluded
  assert.deepEqual(metrics.repo, {
    added: 37,
    removed: 3,
    growth: 34,
    churn: 40,
    modifications: 4, // c1, c2, c4, c5 — c3 is a pure rename
    modFrequency: 0.8,
    churnRate: 8,
  });

  const files = Object.fromEntries(metrics.files.map((f) => [f.path, f]));
  assert.deepEqual(files["c.txt"], {
    path: "c.txt",
    added: 10,
    removed: 0,
    growth: 10,
    churn: 10,
    modifications: 1,
    modFrequency: 0.2,
    churnRate: 2,
  });
  assert.deepEqual(files["b.txt"], {
    path: "b.txt",
    added: 3,
    removed: 1,
    growth: 2,
    churn: 4,
    modifications: 1, // c3's pure rename is not a modification, only c4's edit
    modFrequency: 0.2,
    churnRate: 0.8,
  });
});

test("manual commit list — sums over any subset of H-bar", async () => {
  const { queryCommitSetMetrics } = await import("../lib/queries.ts");

  // c3 is a pure rename (+0 −0 on b.txt), c6 deletes c.txt (−10).
  const metrics = queryCommitSetMetrics(repoId, await manual(3, 6));
  assert.equal(metrics.size, 2);
  assert.deepEqual(metrics.repo, {
    added: 0,
    removed: 10,
    growth: -10,
    churn: 10,
    modifications: 1,
    modFrequency: 0.5,
    churnRate: 5,
  });

  const files = Object.fromEntries(metrics.files.map((f) => [f.path, f]));
  assert.equal(metrics.files.length, 2);
  assert.deepEqual(files["b.txt"], {
    path: "b.txt",
    added: 0,
    removed: 0,
    growth: 0,
    churn: 0,
    modifications: 0,
    modFrequency: 0,
    churnRate: 0,
  });
  assert.deepEqual(files["c.txt"], {
    path: "c.txt",
    added: 0,
    removed: 10,
    growth: -10,
    churn: 10,
    modifications: 1,
    modFrequency: 0.5,
    churnRate: 5,
  });
  assert.deepEqual(metrics.directories, [{ path: ".", ...metrics.repo }]);
});

test("picker tokens resolve exact shas and unique prefixes, unknown ones are dropped", async () => {
  const { queryCommitSetMetrics, resolveCommitShas } = await import("../lib/queries.ts");

  const c6 = await shaOf(6);
  const { shas, unknown } = resolveCommitShas(repoId, [
    c6.slice(0, 8).toUpperCase(),
    "zzzzz-not-a-commit",
    c6,
  ]);
  assert.deepEqual(shas, [c6], "prefix and exact sha both resolve; no duplicate");
  assert.deepEqual(unknown, ["zzzzz-not-a-commit"]);

  const metrics = queryCommitSetMetrics(repoId, { mode: "commits", shas });
  assert.equal(metrics.size, 1);
  assert.deepEqual(metrics.repo, {
    added: 0,
    removed: 10,
    growth: -10,
    churn: 10,
    modifications: 1,
    modFrequency: 1,
    churnRate: 10,
  });
});

test("an empty manual selection is the empty commit set: all metrics zero, η = ρ = 0", async () => {
  const { queryCommitSetMetrics } = await import("../lib/queries.ts");

  const metrics = queryCommitSetMetrics(repoId, { mode: "commits", shas: [] });
  assert.equal(metrics.size, 0);
  assert.deepEqual(metrics.repo, {
    added: 0,
    removed: 0,
    growth: 0,
    churn: 0,
    modifications: 0,
    modFrequency: 0,
    churnRate: 0,
  });
  assert.deepEqual(metrics.files, []);
  assert.deepEqual(metrics.directories, []);
});
