import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { getDb } from "../db";
import { rollupCommitDeltas } from "../rollup";
import { findRepoLocation, gitOutput } from "./gitcli";
import { parseGitLog, type ParsedCommit } from "./parseLog";

export interface IngestResult {
  repoId: number;
  commitCount: number;
  fileDeltaCount: number;
  dirDeltaCount: number;
}

const LOG_FORMAT = "%x01%H%x02%P%x02%ct%x02%an%x02%ae";

/** Extracts an uploaded zip and ingests whatever Git repository it contains. */
export function ingestFromZip(zipPath: string, opts: { name: string }): IngestResult {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rat-unzip-"));
  try {
    const extractDir = path.join(workDir, "extract");
    fs.mkdirSync(extractDir, { recursive: true });
    try {
      new AdmZip(zipPath).extractAllTo(extractDir, true);
    } catch {
      throw new Error("Could not extract the uploaded file. Is it a valid .zip archive?");
    }
    return ingestFromDirectory(extractDir, { name: opts.name, sourceKind: "zip" });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * The ingest pipeline: reads the full history once and stores per-commit
 * file deltas in SQLite, plus the directory metrics of every commit as a
 * recursive rollup over the file deltas (root "." = repository metrics).
 * Every later metric is a SQL aggregation over this data.
 *
 * Hard rules enforced by the git invocation:
 * - --no-merges: H-bar is the set of non-merge commits reachable from the ref
 * - --find-renames=50%: pure renames change no metrics; a rename+edit counts
 *   only the edit, attributed to the new path (handled in parseLog)
 * - deletions appear as removed lines on the deleted path
 * - committer date is stored per commit (%ct); raw author name/email are kept
 *   for the author-merge step later
 */
export function ingestFromDirectory(
  repoDir: string,
  opts: { name: string; sourceKind: "zip" },
): IngestResult {
  const location = findRepoLocation(repoDir);
  const gitDirFlag = location.args;

  const output = gitOutput([
    ...gitDirFlag,
    "-c",
    "core.quotepath=false",
    "log",
    "--no-merges",
    "--find-renames=50%",
    "--numstat",
    `--format=${LOG_FORMAT}`,
    "HEAD",
  ]);

  const commits = parseGitLog(output);
  if (commits.length === 0) {
    throw new Error("The repository has no commits.");
  }

  const db = getDb();
  const repoId = Number(
    db
      .prepare("INSERT INTO repos (name, source_kind, source_ref) VALUES (?, ?, ?)")
      .run(opts.name, opts.sourceKind, "HEAD").lastInsertRowid,
  );

  let fileDeltaCount = 0;
  let dirDeltaCount = 0;
  try {
    const insertCommit = db.prepare(
      `INSERT INTO commits (repo_id, sha, parent_sha, author_name, author_email, committer_ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertDelta = db.prepare(
      `INSERT INTO file_deltas (repo_id, commit_id, path, added, removed)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertDirDelta = db.prepare(
      `INSERT INTO dir_deltas (repo_id, commit_id, path, added, removed)
       VALUES (?, ?, ?, ?, ?)`,
    );

    const tx = db.transaction((rows: ParsedCommit[]) => {
      for (const commit of rows) {
        const commitId = Number(
          insertCommit.run(
            repoId,
            commit.sha,
            commit.parentSha,
            commit.authorName,
            commit.authorEmail,
            commit.committerTs,
          ).lastInsertRowid,
        );
        for (const file of commit.files) {
          insertDelta.run(repoId, commitId, file.path, file.added, file.removed);
          fileDeltaCount += 1;
        }
        for (const dir of rollupCommitDeltas(commit.files)) {
          insertDirDelta.run(repoId, commitId, dir.path, dir.added, dir.removed);
          dirDeltaCount += 1;
        }
      }
    });
    tx(commits);

    db.prepare("UPDATE repos SET commit_count = ? WHERE id = ?").run(commits.length, repoId);
  } catch (err) {
    db.prepare("DELETE FROM repos WHERE id = ?").run(repoId);
    throw err;
  }

  return { repoId, commitCount: commits.length, fileDeltaCount, dirDeltaCount };
}
