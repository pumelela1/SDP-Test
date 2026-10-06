import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface RepoLocation {
  /** Arguments that make git operate on this repository, e.g. ["-C", dir]. */
  args: string[];
  describe: string;
}

const MAX_DEPTH = 3;
const SKIP_DIRS = new Set(["node_modules", ".next"]);

/**
 * Finds the Git repository inside an extracted upload. Handles both a normal
 * worktree (a directory containing .git) and a bare/dot-git directory itself.
 */
export function findRepoLocation(rootDir: string): RepoLocation {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;

    if (fs.existsSync(path.join(dir, ".git"))) {
      // git -C also resolves a ".git" *file* (worktree pointer).
      return { args: ["-C", dir], describe: dir };
    }
    if (looksLikeGitDir(dir)) {
      return { args: ["--git-dir", dir], describe: dir };
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

function looksLikeGitDir(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "HEAD")) &&
    fs.existsSync(path.join(dir, "objects")) &&
    fs.existsSync(path.join(dir, "refs"))
  );
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
