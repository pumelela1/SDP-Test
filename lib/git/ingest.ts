import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { getDb } from "../db";
import { rollupCommitDeltas } from "../rollup";
import { cloneMirror, findRepoLocation, gitOutput } from "./gitcli";
import { parseGitLog, type ParsedCommit } from "./parseLog";

export interface IngestResult {
  repoId: number;
  commitCount: number;
  fileDeltaCount: number;
  dirDeltaCount: number;
  /** True when a .mailmap was found and applied to the author identities. */
  mailmapApplied: boolean;
}

const LOG_FORMAT = "%x01%H%x02%P%x02%ct%x02%an%x02%ae%x02%aN%x02%aE";

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
 * Derives a display name from a clone URL: the last path segment with a .git
 * suffix removed ("https://host/owner/cJSON.git" -> "cJSON",
 * "git@host:owner/cJSON.git" -> "cJSON"). Empty when nothing sensible can be
 * derived, so callers can fall back to a default.
 */
export function repoNameFromUrl(url: string): string {
  let rest = url.trim();
  const scheme = rest.indexOf("://");
  if (scheme !== -1) rest = rest.slice(scheme + 3);
  const at = rest.indexOf("@");
  if (at !== -1) rest = rest.slice(at + 1);
  let last = rest.split(/[\\/]/).filter((segment) => segment !== "").pop() ?? "";
  const colon = last.lastIndexOf(":");
  if (colon !== -1) last = last.slice(colon + 1);
  if (/\.git$/i.test(last)) last = last.slice(0, -".git".length);
  return last;
}

/**
 * Ingests a remote repository URL: deep-clones it with `git clone --mirror`
 * (bare, every ref copied, full history) into a temp directory, then runs the
 * exact same pipeline as a zip upload. A mirror is a bare repository, so the
 * reference commit is its HEAD and a committed .mailmap is applied through the
 * mailmap.blob path of the pipeline.
 */
export function ingestFromUrl(url: string, opts: { name: string }): IngestResult {
  const trimmed = url.trim();
  if (trimmed === "") {
    throw new Error("Provide a repository URL to clone.");
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rat-clone-"));
  try {
    const mirrorDir = path.join(workDir, "mirror.git");
    cloneMirror(trimmed, mirrorDir);
    return ingestFromDirectory(mirrorDir, { name: opts.name, sourceKind: "url" });
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
 * - -z: raw NUL-separated paths with explicit old/new for renames, so rename
 *   attribution stays exact whatever characters a filename contains
 * - deletions appear as removed lines on the deleted path
 * - committer date is stored per commit (%ct)
 * - the author identity is stored twice: raw (%an/%ae) and canonical
 *   (%aN/%aE, the repository's .mailmap already applied by git) — h[a] for
 *   every author metric is the canonical identity, and the raw one is kept
 *   so a later manual merge can re-map it
 */
export function ingestFromDirectory(
  repoDir: string,
  opts: { name: string; sourceKind: "zip" | "url" },
): IngestResult {
  const location = findRepoLocation(repoDir);
  const gitDirFlag = location.args;

  const output = gitOutput([
    ...gitDirFlag,
    ...location.mailmapArgs,
    "-c",
    "core.quotepath=false",
    "log",
    "--no-merges",
    "--find-renames=50%",
    "--numstat",
    "-z",
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
      `INSERT INTO commits (repo_id, sha, parent_sha, author_name, author_email, canonical_name, canonical_email, committer_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
            commit.canonicalName,
            commit.canonicalEmail,
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

  return {
    repoId,
    commitCount: commits.length,
    fileDeltaCount,
    dirDeltaCount,
    mailmapApplied: location.hasMailmap,
  };
}
