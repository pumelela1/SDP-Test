import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EXPECTED, makeFixtureRepo, zipDir } from "./makeFixtureRepo.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rat-test-"));
process.env.RAT_DB_PATH = path.join(tmpRoot, "test.db");

const repoDir = path.join(tmpRoot, "fixture-repo");
makeFixtureRepo(repoDir);

let directRepoId = 0;

test("fixture repo totals match hand-computed values (ingest hard rules)", async () => {
  const { ingestFromDirectory } = await import("../lib/git/ingest.ts");
  const { queryFileTotals, summarizeTotals } = await import("../lib/queries.ts");

  const result = ingestFromDirectory(repoDir, { name: "fixture", sourceKind: "zip" });
  directRepoId = result.repoId;

  // H-bar: non-merge commits reachable from HEAD (the merge commit is excluded).
  assert.equal(result.commitCount, EXPECTED.commitCount);

  const files = queryFileTotals(result.repoId);
  const got = Object.fromEntries(
    files.map((f) => [f.path, { added: f.added, removed: f.removed }]),
  );

  assert.deepEqual(got, EXPECTED.files);
  // "in" rather than indexing: got's inferred keys are the fixture's literal paths.
  assert.equal("bin.dat" in got, false, "binary file must not be measured");
  assert.deepEqual(summarizeTotals(files), EXPECTED.totals);
});

test("directory rollup matches hand-computed values (root = repo)", async () => {
  const {
    queryDirectoryTotals,
    queryFileTotals,
    queryRepoTotals,
    summarizeTotals,
  } = await import("../lib/queries.ts");

  const directories = queryDirectoryTotals(directRepoId);
  const got = Object.fromEntries(
    directories.map((d) => [d.path, { added: d.added, removed: d.removed }]),
  );
  assert.deepEqual(got, EXPECTED.directories);
  assert.deepEqual(
    got["src/app"],
    { added: 5, removed: 5 },
    "a created-then-deleted directory keeps both directions",
  );
  assert.equal("src/lib/helper.txt" in got, false, "files must not appear as directories");

  // Repo metrics are the directory metrics at the root and must equal the sum over files.
  assert.deepEqual(queryRepoTotals(directRepoId), EXPECTED.totals);
  assert.deepEqual(queryRepoTotals(directRepoId), summarizeTotals(queryFileTotals(directRepoId)));
});

test("zip upload path produces identical totals", async () => {
  const { ingestFromZip } = await import("../lib/git/ingest.ts");
  const { queryDirectoryTotals, queryFileTotals, summarizeTotals } = await import(
    "../lib/queries.ts"
  );

  const zipPath = zipDir(repoDir, path.join(tmpRoot, "fixture.zip"));
  const result = ingestFromZip(zipPath, { name: "fixture-zip" });

  assert.equal(result.commitCount, EXPECTED.commitCount);
  assert.deepEqual(summarizeTotals(queryFileTotals(result.repoId)), EXPECTED.totals);
  assert.deepEqual(
    Object.fromEntries(
      queryDirectoryTotals(result.repoId).map((d) => [
        d.path,
        { added: d.added, removed: d.removed },
      ]),
    ),
    EXPECTED.directories,
  );
});

test("zip without a Git repository is rejected", async () => {
  const { ingestFromZip } = await import("../lib/git/ingest.ts");

  const plainDir = path.join(tmpRoot, "plain");
  fs.mkdirSync(plainDir, { recursive: true });
  fs.writeFileSync(path.join(plainDir, "hello.txt"), "hi\n");
  const zipPath = zipDir(plainDir, path.join(tmpRoot, "plain.zip"));

  assert.throws(() => ingestFromZip(zipPath, { name: "plain" }), /No Git repository/i);
});

test("corrupt zip is rejected with a friendly error", async () => {
  const { ingestFromZip } = await import("../lib/git/ingest.ts");

  const badZip = path.join(tmpRoot, "bad.zip");
  fs.writeFileSync(badZip, "this is not a zip");

  assert.throws(() => ingestFromZip(badZip, { name: "bad" }), /zip/i);
});

test("URL ingestion (git clone --mirror) produces identical totals", async () => {
  const { ingestFromUrl } = await import("../lib/git/ingest.ts");
  const { queryDirectoryTotals, queryFileTotals, summarizeTotals } = await import(
    "../lib/queries.ts"
  );

  // file:// forces the real clone transport, so the offline test exercises
  // the same code path as an https:// URL.
  const result = ingestFromUrl(`file://${repoDir}`, { name: "fixture-url" });

  assert.equal(result.commitCount, EXPECTED.commitCount);
  assert.deepEqual(summarizeTotals(queryFileTotals(result.repoId)), EXPECTED.totals);
  assert.deepEqual(
    Object.fromEntries(
      queryDirectoryTotals(result.repoId).map((d) => [
        d.path,
        { added: d.added, removed: d.removed },
      ]),
    ),
    EXPECTED.directories,
  );
});

test("URL ingestion rejects an empty or unclonable URL and adds no repository", async () => {
  const { ingestFromUrl } = await import("../lib/git/ingest.ts");
  const { getDb } = await import("../lib/db.ts");

  assert.throws(() => ingestFromUrl("   ", { name: "empty" }), /URL/i);

  const count = () =>
    (getDb().prepare("SELECT COUNT(*) AS n FROM repos").get() as { n: number }).n;
  const before = count();
  assert.throws(
    () => ingestFromUrl("file:///definitely/not/a/repo.git", { name: "nope" }),
    /failed/i,
  );
  assert.equal(count(), before, "a failed clone must not leave a repository row behind");
});

test("cross-check: stored totals equal raw git numstat sums", async () => {
  const { getDb } = await import("../lib/db.ts");
  const { resolveNumstatPath } = await import("../lib/git/parseLog.ts");

  const raw = execFileSync(
    "git",
    [
      "-C",
      repoDir,
      "log",
      "--no-merges",
      "--find-renames=50%",
      "--numstat",
      "--format=",
    ],
    { encoding: "utf8" },
  );

  let added = 0;
  let removed = 0;
  // Independent rollup: every row contributes to each of its ancestor directories.
  const byDir = new Map<string, { added: number; removed: number }>();
  const bump = (dir: string, a: number, r: number) => {
    const entry = byDir.get(dir) ?? { added: 0, removed: 0 };
    entry.added += a;
    entry.removed += r;
    byDir.set(dir, entry);
  };
  for (const line of raw.split("\n")) {
    const parts = line.split("\t");
    if (parts.length !== 3) continue;
    const [a, r] = parts;
    if (a === "-" || r === "-") continue;
    const aNum = Number.parseInt(a, 10);
    const rNum = Number.parseInt(r, 10);
    added += aNum;
    removed += rNum;

    const filePath = resolveNumstatPath(parts.slice(2).join("\t"));
    const segments = filePath.split("/");
    for (let cut = segments.length - 1; cut >= 1; cut -= 1) {
      bump(segments.slice(0, cut).join("/"), aNum, rNum);
    }
    bump(".", aNum, rNum);
  }

  const db = getDb();
  const sums = db
    .prepare(
      "SELECT SUM(added) AS added, SUM(removed) AS removed FROM file_deltas WHERE repo_id = ?",
    )
    .get(directRepoId) as { added: number; removed: number };
  assert.deepEqual(sums, { added, removed });

  const dirRows = db
    .prepare(
      `SELECT path, SUM(added) AS added, SUM(removed) AS removed
       FROM dir_deltas WHERE repo_id = ? GROUP BY path ORDER BY path`,
    )
    .all(directRepoId) as Array<{ path: string; added: number; removed: number }>;
  const expectedDirs = [...byDir.entries()]
    .filter(([, sum]) => sum.added !== 0 || sum.removed !== 0) // zero rows are dropped at ingest
    .map(([path, sum]) => ({ path, added: sum.added, removed: sum.removed }))
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  assert.deepEqual(dirRows, expectedDirs);

  const count = db
    .prepare("SELECT COUNT(*) AS n FROM commits WHERE repo_id = ?")
    .get(directRepoId) as { n: number };
  assert.equal(count.n, EXPECTED.commitCount);
});
