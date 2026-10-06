import type { ParsedFileDelta } from "./git/parseLog";

export interface DirDelta {
  path: string;
  added: number;
  removed: number;
}

/** The repository root; repository metrics are the directory metrics at this path. */
export const ROOT_DIR = ".";

/**
 * Directories containing a file, from its immediate parent up to the root:
 * "c.txt" -> ["."], "a/b.txt" -> ["a", "."], "a/b/c.txt" -> ["a/b", "a", "."].
 */
export function ancestorDirectories(filePath: string): string[] {
  const segments = filePath.split("/");
  const dirs: string[] = [];
  for (let cut = segments.length - 1; cut >= 1; cut -= 1) {
    dirs.push(segments.slice(0, cut).join("/"));
  }
  dirs.push(ROOT_DIR);
  return dirs;
}

/**
 * Directory metrics for one commit: l+/l-/d/l of a directory is the sum over
 * its immediate child files and subdirectories, which recursively makes it the
 * sum over every file below it. Each file delta is therefore added to all of
 * its ancestor directories, root included (root = repository metrics).
 *
 * Pure renames arrive here as +0 -0 rows (parseLog attributes renames to the new
 * path) and are dropped: a rename alone must change no metrics, and an all-zero
 * directory row would carry no signal.
 */
export function rollupCommitDeltas(files: ParsedFileDelta[]): DirDelta[] {
  const perDir = new Map<string, { added: number; removed: number }>();
  for (const file of files) {
    for (const dir of ancestorDirectories(file.path)) {
      const entry = perDir.get(dir);
      if (entry === undefined) {
        perDir.set(dir, { added: file.added, removed: file.removed });
      } else {
        entry.added += file.added;
        entry.removed += file.removed;
      }
    }
  }

  return [...perDir.entries()]
    .filter(([, sum]) => sum.added !== 0 || sum.removed !== 0)
    .map(([path, sum]) => ({ path, added: sum.added, removed: sum.removed }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
