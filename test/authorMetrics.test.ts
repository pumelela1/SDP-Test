import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AUTHOR_EXPECTED, makeAuthorFixtureRepo, zipDir } from "./makeAuthorFixtureRepo.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rat-authors-"));

// The database starts as a pre-author-metrics schema so the in-place
// migration (canonical_name/canonical_email backfill) is exercised too.
process.env.RAT_DB_PATH = path.join(tmpRoot, "test.db");

// The fixture commits are stamped 1700000000 + i*3600 in call order (c1..c9).
const ts = (commitNumber: number) => 1700000000 + commitNumber * 3600;

const mailmapRepoDir = path.join(tmpRoot, "mailmap-repo");
makeAuthorFixtureRepo(mailmapRepoDir);
const plainRepoDir = path.join(tmpRoot, "plain-repo"); // no .mailmap at all
makeAuthorFixtureRepo(plainRepoDir, { withMailmap: false });

const ANN = "ann@corp.example";
const BOB = "bob@corp.example";

let repoId = 0;
let plainRepoId = 0;

/** Recreates the pre-author-metrics schema plus one legacy row. */
async function createLegacyDatabase(): Promise<void> {
  const { default: Database } = await import("better-sqlite3");
  const raw = new Database(process.env.RAT_DB_PATH);
  raw.exec(`
    CREATE TABLE repos (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      source_kind  TEXT NOT NULL,
      source_ref   TEXT NOT NULL DEFAULT 'HEAD',
      commit_count INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE commits (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      sha           TEXT NOT NULL,
      parent_sha    TEXT,
      author_name   TEXT NOT NULL,
      author_email  TEXT NOT NULL,
      committer_ts  INTEGER NOT NULL
    );
    CREATE TABLE file_deltas (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      commit_id  INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
      path       TEXT NOT NULL,
      added      INTEGER NOT NULL,
      removed    INTEGER NOT NULL
    );
    CREATE TABLE dir_deltas (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      commit_id  INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
      path       TEXT NOT NULL,
      added      INTEGER NOT NULL,
      removed    INTEGER NOT NULL
    );
  `);
  raw
    .prepare("INSERT INTO repos (name, source_kind, commit_count) VALUES ('legacy', 'zip', 1)")
    .run();
  raw
    .prepare(
      "INSERT INTO commits (repo_id, sha, parent_sha, author_name, author_email, committer_ts) VALUES (1, 'oldsha', NULL, 'Old Author', 'old@example.com', 1)",
    )
    .run();
  raw.close();
}

test("an old database is migrated: canonical columns added and backfilled", async () => {
  await createLegacyDatabase();
  const { getDb } = await import("../lib/db.ts");

  const columns = (
    getDb().prepare("SELECT name FROM pragma_table_info('commits')").all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
  assert.ok(columns.includes("canonical_name"), "canonical_name column added");
  assert.ok(columns.includes("canonical_email"), "canonical_email column added");

  const old = getDb()
    .prepare("SELECT author_name, canonical_name, author_email, canonical_email FROM commits WHERE sha = 'oldsha'")
    .get() as { author_name: string; canonical_name: string; author_email: string; canonical_email: string };
  assert.deepEqual(
    { name: old.canonical_name, email: old.canonical_email },
    { name: old.author_name, email: old.author_email },
    "pre-existing rows keep their raw identity as the canonical one",
  );
});

test(".mailmap auto-applied: merged authors keep every commit, churn and ownership", async () => {
  const { ingestFromDirectory } = await import("../lib/git/ingest.ts");
  const { countMailmapMergedCommits, queryAuthorLeaderboard } = await import("../lib/queries.ts");

  const result = ingestFromDirectory(mailmapRepoDir, { name: "authors", sourceKind: "zip" });
  repoId = result.repoId;
  assert.equal(result.commitCount, AUTHOR_EXPECTED.commitCount);
  assert.equal(result.mailmapApplied, true, "a committed .mailmap was found and applied");
  assert.equal(countMailmapMergedCommits(repoId), AUTHOR_EXPECTED.mailmapMergedCommits);

  const leaderboard = queryAuthorLeaderboard(repoId, { mode: "all", shas: [] });
  assert.deepEqual(
    leaderboard.map((a) => a.email),
    [ANN, BOB],
    "two canonical authors after the mailmap merge, ordered by churn",
  );
  assert.deepEqual(leaderboard[0], AUTHOR_EXPECTED.authors[ANN]);
  assert.deepEqual(leaderboard[1], AUTHOR_EXPECTED.authors[BOB]);
});

test("author mods / churn / ownership on files and directories (H = H-bar)", async () => {
  const { queryObjectAuthorMetrics, queryObjectTopAuthors } = await import("../lib/queries.ts");
  const filter = { mode: "all" as const, shas: [] };

  for (const [objectPath, expected] of Object.entries(AUTHOR_EXPECTED.objects)) {
    const metrics = queryObjectAuthorMetrics(repoId, filter, objectPath);
    assert.ok(metrics, `author metrics exist for ${objectPath}`);
    assert.equal(metrics.churn, expected.churn, `churn of ${objectPath}`);
    assert.deepEqual(
      metrics.authors.map((a) => [a.email, a.modifications, a.churn, a.ownership]),
      Object.entries(expected.authors).map(([email, a]) => [email, a.modifications, a.churn, a.ownership]),
      `per-author rows of ${objectPath}`,
    );
  }

  // The pure-rename target keeps its author row with ω = 0 (λ = 0).
  const renamed = queryObjectAuthorMetrics(repoId, filter, "c.txt")!;
  assert.equal(renamed.kind, "file");
  assert.equal(renamed.authors[0].ownership, 0);
  assert.equal(renamed.authors[0].modifications, 0);

  // Top author per object: max churn, ties broken deterministically.
  const topFiles = queryObjectTopAuthors(repoId, filter, "file_deltas");
  const top = new Map(topFiles.map((row) => [row.path, row]));
  assert.equal(top.get("a.txt")!.name, "Ann A");
  assert.equal(top.get("a.txt")!.ownership, 1);
  assert.equal(top.get("b.txt")!.name, "Bob B");
  assert.equal(top.get("c.txt")!.ownership, 0, "ω = 0 when the object's churn is 0");
  assert.equal(top.get("src/x.txt")!.ownership, 1);

  const topDirs = queryObjectTopAuthors(repoId, filter, "dir_deltas");
  const root = topDirs.find((row) => row.path === ".")!;
  assert.equal(root.name, "Ann A");
  assert.equal(root.ownership, 26 / 35);

  // An unknown path has no author metrics at all.
  assert.equal(queryObjectAuthorMetrics(repoId, filter, "no/such/path.txt"), null);
});

test("raw author identities are preserved for a later manual merge", async () => {
  const { getDb } = await import("../lib/db.ts");

  const rows = getDb()
    .prepare(
      `SELECT author_name, author_email, canonical_name, canonical_email
       FROM commits WHERE repo_id = ? ORDER BY committer_ts`,
    )
    .all(repoId) as Array<{
    author_name: string;
    author_email: string;
    canonical_name: string;
    canonical_email: string;
  }>;
  assert.equal(rows.length, AUTHOR_EXPECTED.commitCount);
  const alt = rows.find((row) => row.author_email === "ann@personal.example")!;
  assert.deepEqual(
    { name: alt.canonical_name, email: alt.canonical_email },
    { name: "Ann A", email: ANN },
    "the mapped identity is stored next to the raw one",
  );
  // Four commits carry a non-canonical raw identity (c2, c4, c5, c8).
  assert.equal(
    rows.filter((row) => row.author_name !== row.canonical_name).length,
    AUTHOR_EXPECTED.mailmapMergedCommits,
  );
});

test("author metrics follow the commit-set filters", async () => {
  const { queryAuthorLeaderboard, queryObjectAuthorMetrics } = await import("../lib/queries.ts");

  // Period from c5's committer date: H = {c5..c9}.
  const period = queryAuthorLeaderboard(repoId, {
    mode: "period",
    fromTs: ts(5),
    shas: [],
  });
  const byEmail = Object.fromEntries(period.map((a) => [a.email, a]));
  assert.equal(period.reduce((sum, a) => sum + a.churn, 0), 11);
  assert.equal(byEmail[ANN].commits, 3); // c6, c8, c9
  assert.equal(byEmail[ANN].churn, 8);
  assert.equal(byEmail[ANN].ownership, 8 / 11);
  assert.equal(byEmail[BOB].commits, 2); // c5, c7 (the pure rename)
  assert.equal(byEmail[BOB].churn, 3);
  assert.equal(byEmail[BOB].ownership, 3 / 11);

  // Manual list {c2, c3}: Ann owns her edit of a.txt, Bob his add of b.txt.
  const { getDb } = await import("../lib/db.ts");
  const shas = (
    getDb()
      .prepare("SELECT sha FROM commits WHERE repo_id = ? AND committer_ts IN (?, ?) ORDER BY committer_ts")
      .all(repoId, ts(2), ts(3)) as Array<{ sha: string }>
  ).map((row) => row.sha);
  const manualFilter = { mode: "commits" as const, shas };
  const manual = queryAuthorLeaderboard(repoId, manualFilter);
  assert.deepEqual(
    manual.map((a) => [a.email, a.commits, a.churn, a.ownership]),
    [
      [BOB, 1, 6, 0.6], // c3: b.txt +6
      [ANN, 1, 4, 0.4], // c2: a.txt +3 -1
    ],
  );

  const aTxt = queryObjectAuthorMetrics(repoId, manualFilter, "a.txt")!;
  assert.deepEqual(
    aTxt.authors.map((a) => [a.email, a.modifications, a.churn, a.ownership]),
    [[ANN, 1, 4, 1]],
  );
});

test("without a .mailmap, raw identities stay distinct authors", async () => {
  const { ingestFromDirectory } = await import("../lib/git/ingest.ts");
  const { countMailmapMergedCommits, queryAuthorLeaderboard } = await import("../lib/queries.ts");

  const result = ingestFromDirectory(plainRepoDir, { name: "plain", sourceKind: "zip" });
  plainRepoId = result.repoId;
  assert.equal(result.mailmapApplied, false);
  assert.equal(result.commitCount, AUTHOR_EXPECTED.withoutMailmap.commitCount);
  assert.equal(countMailmapMergedCommits(plainRepoId), 0);

  const leaderboard = queryAuthorLeaderboard(plainRepoId, { mode: "all", shas: [] });
  const expected = AUTHOR_EXPECTED.withoutMailmap.authors;
  assert.equal(leaderboard.length, 4);
  for (const row of leaderboard) {
    const want = expected[row.email];
    assert.ok(want, `unexpected author ${row.email}`);
    assert.equal(row.commits, want.commits, `commits of ${row.email}`);
    assert.equal(row.churn, want.churn, `churn of ${row.email}`);
    assert.equal(row.ownership, want.ownership, `ownership of ${row.email}`);
  }
});

test("a .mailmap in the server cwd never leaks into the metrics", async () => {
  const { ingestFromDirectory } = await import("../lib/git/ingest.ts");
  const { queryAuthorLeaderboard } = await import("../lib/queries.ts");

  const cwdDir = path.join(tmpRoot, "cwd-decoy");
  fs.mkdirSync(cwdDir, { recursive: true });
  fs.writeFileSync(
    path.join(cwdDir, ".mailmap"),
    "Evil <evil@evil.example> <ann@personal.example>\n",
  );

  const previousCwd = process.cwd();
  process.chdir(cwdDir);
  try {
    // The plain (no-mailmap) repo must NOT pick up the decoy .mailmap of the cwd.
    const plain = ingestFromDirectory(plainRepoDir, { name: "plain-decoy", sourceKind: "zip" });
    const plainAuthors = queryAuthorLeaderboard(plain.repoId, { mode: "all", shas: [] });
    assert.equal(
      plainAuthors.some((a) => a.email === "evil@evil.example"),
      false,
      "an ambient .mailmap of the process cwd must not merge anything",
    );
    assert.equal(plainAuthors.length, 4, "the four raw identities stay distinct");

    // The mailmap repo still merges with ITS OWN .mailmap, not the decoy.
    const mapped = ingestFromDirectory(mailmapRepoDir, { name: "mailmap-decoy", sourceKind: "zip" });
    const mappedAuthors = queryAuthorLeaderboard(mapped.repoId, { mode: "all", shas: [] });
    assert.deepEqual(
      mappedAuthors.map((a) => a.email),
      [ANN, BOB],
      "the repository's own .mailmap wins over the ambient one",
    );
  } finally {
    process.chdir(previousCwd);
  }
});

test("mailmap applies through the upload paths: worktree zip and .git-only zip", async () => {
  const { ingestFromZip } = await import("../lib/git/ingest.ts");
  const { queryAuthorLeaderboard } = await import("../lib/queries.ts");

  // A worktree whose .mailmap file was removed from disk: the committed
  // .mailmap at HEAD must still be applied (mailmap.blob fallback).
  const noFileDir = path.join(tmpRoot, "worktree-no-mailmap-file");
  fs.cpSync(mailmapRepoDir, noFileDir, { recursive: true });
  fs.rmSync(path.join(noFileDir, ".mailmap"));
  const noFile = ingestFromZip(zipDir(noFileDir, path.join(tmpRoot, "no-file.zip")), {
    name: "authors-zip-nofile",
  });
  assert.equal(noFile.mailmapApplied, true);
  assert.deepEqual(
    queryAuthorLeaderboard(noFile.repoId, { mode: "all", shas: [] }).map((a) => a.email),
    [ANN, BOB],
  );

  // A zip of just the .git directory (no worktree at all).
  const gitOnlyZip = zipDir(
    path.join(mailmapRepoDir, ".git"),
    path.join(tmpRoot, "git-only.zip"),
  );
  const gitOnly = ingestFromZip(gitOnlyZip, { name: "authors-zip-gitdir" });
  assert.equal(gitOnly.mailmapApplied, true);
  assert.equal(gitOnly.commitCount, AUTHOR_EXPECTED.commitCount);
  assert.deepEqual(
    queryAuthorLeaderboard(gitOnly.repoId, { mode: "all", shas: [] }),
    queryAuthorLeaderboard(repoId, { mode: "all", shas: [] }),
    "the .git-only zip yields the exact same author metrics",
  );

  // And a plain-repo zip stays unmerged.
  const plainZip = ingestFromZip(zipDir(plainRepoDir, path.join(tmpRoot, "plain.zip")), {
    name: "plain-zip",
  });
  assert.equal(plainZip.mailmapApplied, false);
  assert.equal(
    queryAuthorLeaderboard(plainZip.repoId, { mode: "all", shas: [] }).length,
    4,
  );
});

test("mailmap applies through the URL path: a mirror clone is bare, so the committed .mailmap is used", async () => {
  const { ingestFromUrl } = await import("../lib/git/ingest.ts");
  const { queryAuthorLeaderboard } = await import("../lib/queries.ts");

  // git clone --mirror produces a bare repository with no worktree, so the
  // .mailmap can only come from HEAD:.mailmap (the mailmap.blob branch).
  const result = ingestFromUrl(`file://${mailmapRepoDir}`, { name: "authors-url" });
  assert.equal(result.mailmapApplied, true);
  assert.equal(result.commitCount, AUTHOR_EXPECTED.commitCount);
  assert.deepEqual(
    queryAuthorLeaderboard(result.repoId, { mode: "all", shas: [] }),
    queryAuthorLeaderboard(repoId, { mode: "all", shas: [] }),
    "the clone yields the exact same author metrics as the zip path",
  );
});
