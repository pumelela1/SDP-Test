import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface RepoLocation {
  /** Arguments that make git operate on this repository, e.g. ["-C", dir]. */
  args: string[];
  /**
   * Extra `-c` arguments that make `git log` apply this repository's .mailmap
   * (empty when git finds the mailmap on its own — the worktree file).
   */
  mailmapArgs: string[];
  /** True when a .mailmap was found for this repository. */
  hasMailmap: boolean;
  describe: string;
}

const MAX_DEPTH = 3;
const SKIP_DIRS = new Set(["node_modules", ".next"]);

/**
 * Finds the Git repository inside an extracted upload. Handles both a normal
 * worktree (a directory containing .git) and a bare/dot-git directory itself.
 *
 * Also locates the repository's .mailmap, which git log must apply when the
 * author identities are read (the %aN/%aE placeholders):
 * - worktree with a .mailmap file on disk: git reads it automatically
 * - a .mailmap committed at HEAD (the usual case for a zip that carries only
 *   the .git directory, or a worktree without a checked-out file):
 *   mailmap.blob=HEAD:.mailmap — git silently ignores the setting when the
 *   blob is absent, but passing it always would let an ambient ./.mailmap of
 *   the server's cwd win (git only falls back to mailmap.blob when it finds
 *   no worktree file), so it is added only when the blob really exists.
 *
 * Every invocation also gets a `-C` into the repository directory so the
 * process cwd can never leak an unrelated .mailmap into the metrics.
 */
export function findRepoLocation(rootDir: string): RepoLocation {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;

    if (fs.existsSync(path.join(dir, ".git"))) {
      // git -C also resolves a ".git" *file* (worktree pointer).
      const worktreeMailmap = fs.existsSync(path.join(dir, ".mailmap"));
      const committed = worktreeMailmap ? false : committedMailmapExists(["-C", dir]);
      return {
        args: ["-C", dir],
        mailmapArgs: committed ? ["-c", "mailmap.blob=HEAD:.mailmap"] : [],
        hasMailmap: worktreeMailmap || committed,
        describe: dir,
      };
    }
    if (looksLikeGitDir(dir)) {
      const committed = committedMailmapExists(["-C", dir, "--git-dir", dir]);
      return {
        args: ["-C", dir, "--git-dir", dir],
        mailmapArgs: committed ? ["-c", "mailmap.blob=HEAD:.mailmap"] : [],
        hasMailmap: committed,
        describe: dir,
      };
    }

    if (depth >= MAX_DEPTH) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  }

  throw new Error(
    "No Git repository found in the upload. Make sure the zip includes the repository's .git directory.",
  );
}

/** True when the repository has a .mailmap committed at the reference commit. */
function committedMailmapExists(gitArgs: string[]): boolean {
  const result = spawnSync("git", [...gitArgs, "cat-file", "-e", "HEAD:.mailmap"]);
  return result.status === 0;
}

function looksLikeGitDir(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "HEAD")) &&
    fs.existsSync(path.join(dir, "objects")) &&
    fs.existsSync(path.join(dir, "refs"))
  );
}

/**
 * Deep-clones a remote repository into targetDir (which must not exist yet)
 * with `git clone --mirror`: bare, every ref copied, full history. `--quiet`
 * keeps stderr to the fatal lines so a failure can be surfaced verbatim.
 */
export function cloneMirror(url: string, targetDir: string): void {
  const result = spawnSync("git", ["clone", "--quiet", "--mirror", url, targetDir], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Could not run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const lines = (result.stderr || result.stdout || "")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const fatals = lines.filter((line) => line.startsWith("fatal:"));
    const detail =
      (fatals.length > 0 ? fatals : lines).join(" ") || `git exited with status ${result.status}`;
    throw new Error(`Cloning ${url} failed: ${detail}`);
  }
}

export function gitOutput(args: string[]): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Could not run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" ");
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return result.stdout;
}
