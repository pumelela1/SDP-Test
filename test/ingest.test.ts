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
  assert.equal(got["bin.dat"], undefined, "binary file must not be measured");
  assert.deepEqual(summarizeTotals(files), EXPECTED.totals);
});

test("zip upload path produces identical totals", async () => {
  const { ingestFromZip } = await import("../lib/git/ingest.ts");
  const { queryFileTotals, summarizeTotals } = await import("../lib/queries.ts");

  const zipPath = zipDir(repoDir, path.join(tmpRoot, "fixture.zip"));
  const result = ingestFromZip(zipPath, { name: "fixture-zip" });

  assert.equal(result.commitCount, EXPECTED.commitCount);
  assert.deepEqual(summarizeTotals(queryFileTotals(result.repoId)), EXPECTED.totals);
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

test("cross-check: stored totals equal raw git numstat sums", async () => {
  const { getDb } = await import("../lib/db.ts");

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
  for (const line of raw.split("\n")) {
    const parts = line.split("\t");
    if (parts.length !== 3) continue;
    const [a, r] = parts;
    if (a === "-" || r === "-") continue;
    added += Number.parseInt(a, 10);
    removed += Number.parseInt(r, 10);
  }

  const db = getDb();
  const sums = db
    .prepare(
      "SELECT SUM(added) AS added, SUM(removed) AS removed FROM file_deltas WHERE repo_id = ?",
    )
    .get(directRepoId) as { added: number; removed: number };
  assert.deepEqual(sums, { added, removed });

  const count = db
    .prepare("SELECT COUNT(*) AS n FROM commits WHERE repo_id = ?")
    .get(directRepoId) as { n: number };
  assert.equal(count.n, EXPECTED.commitCount);
});
