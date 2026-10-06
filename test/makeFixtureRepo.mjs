import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

// Fixed commit timestamps so later time-window filters stay deterministic.
const BASE_TIME = 1700000000;

/**
 * Hand-computed expectations for the scripted commits below.
 * These are the ground truth the ingest pipeline is checked against.
 */
export const EXPECTED = {
  commitCount: 18, // non-merge commits reachable from HEAD (the merge commit is excluded)
  files: {
    "a.txt": { added: 24, removed: 2 }, // c1 +20 ; c2 +4 -2
    "b.txt": { added: 3, removed: 1 }, // c3 pure rename (+0 -0) ; c4 +3 -1
    "c.txt": { added: 10, removed: 10 }, // c5 +10 ; c6 delete -10
    "d.txt": { added: 5, removed: 2 }, // c8 rename+edit: only the edit, on the NEW path
    "e.txt": { added: 4, removed: 0 }, // c9
    "f.txt": { added: 6, removed: 0 }, // c10 on the feature branch (reachable via the merge)
    "src/app/main.txt": { added: 5, removed: 5 }, // c12 +5 ; c14 delete -5
    "src/lib/helper.txt": { added: 5, removed: 1 }, // c12 +3 ; c13 +2 -1 (later moved to src/support)
    "src/support/helper.txt": { added: 1, removed: 1 }, // c16 rename+edit: only the edit, NEW path
    "deep/one/two/leaf.txt": { added: 2, removed: 0 }, // c15
    'qu"ote.txt': { added: 2, removed: 0 }, // c18 +2 (quoted name); c19 pure rename away (+0 -0)
    "back\\slash.txt": { added: 0, removed: 0 }, // c19 pure rename of qu"ote.txt onto this path
  },
  totals: { added: 67, removed: 22, growth: 45, churn: 89 },
  // Directory metrics are the recursive rollup (sum over immediate children):
  // every ancestor directory already contains all the files below it.
  directories: {
    ".": { added: 67, removed: 22 }, // root = repository metrics
    src: { added: 11, removed: 7 }, // src/app + src/lib + src/support
    "src/app": { added: 5, removed: 5 }, // created by c12, deleted by c14
    "src/lib": { added: 5, removed: 1 },
    "src/support": { added: 1, removed: 1 }, // receives only the c16 rename's edit
    deep: { added: 2, removed: 0 },
    "deep/one": { added: 2, removed: 0 },
    "deep/one/two": { added: 2, removed: 0 },
    // "docs" (c17) never appears: the renamed file is binary, so no row at all.
  },
};

const line = (n) => `line ${n}`;
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const text = (numbers) => numbers.map(line).join("\n") + "\n";

/** Builds a small Git repository with known, hand-checkable metrics. */
export function makeFixtureRepo(repoDir) {
  fs.mkdirSync(repoDir, { recursive: true });

  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  let commitIndex = 0;
  const commit = (message) => {
    commitIndex += 1;
    const stamp = `${BASE_TIME + commitIndex * 3600} +0000`;
    git("add", "-A");
    execFileSync("git", ["commit", "-q", "-m", message], {
      cwd: repoDir,
      env: { ...process.env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  const write = (rel, content) => fs.writeFileSync(path.join(repoDir, rel), content);

  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture Author");
  git("config", "user.email", "fixture@example.com");

  // c1: add a.txt (20 lines).
  write("a.txt", text(range(1, 20)));
  commit("c1 add a.txt with 20 lines");

  // c2: a.txt +4 -2 (drop lines 2-3, append lines 21-24).
  write("a.txt", text([...range(1, 1), ...range(4, 20), ...range(21, 24)]));
  commit("c2 edit a.txt (+4 -2)");

  // c3: pure rename a.txt -> b.txt. Hard rule: a rename alone changes no metrics.
  git("mv", "a.txt", "b.txt");
  commit("c3 pure rename a.txt to b.txt");

  // c4: b.txt +3 -1 (drop line 4, append lines 25-27).
  write("b.txt", text([...range(1, 1), ...range(5, 20), ...range(21, 27)]));
  commit("c4 edit b.txt (+3 -1)");

  // c5: add c.txt (10 lines).
  write("c.txt", text(range(1, 10)));
  commit("c5 add c.txt");

  // c6: delete c.txt. Hard rule: deletion records removed lines on its path.
  git("rm", "-q", "c.txt");
  commit("c6 delete c.txt");

  // c7: add a binary file. Hard rule: binary files are not measured.
  write(
    "bin.dat",
    Buffer.from(Array.from({ length: 512 }, (_, i) => (i % 4 === 0 ? 0 : i % 251))),
  );
  commit("c7 add binary file");

  // c8: rename + edit b.txt -> d.txt (+5 -2).
  // Hard rule: only the edit counts, attributed to the NEW path.
  git("mv", "b.txt", "d.txt");
  write("d.txt", text([...range(6, 20), ...range(21, 27), ...range(28, 32)]));
  commit("c8 rename+edit b.txt to d.txt (+5 -2)");

  // c9: add e.txt (4 lines).
  write("e.txt", text(range(1, 4)));
  commit("c9 add e.txt");

  // c10 on a branch, then merged with --no-ff:
  // the branch commit counts, the merge commit must be excluded from H-bar.
  git("checkout", "-q", "-b", "feature");
  write("f.txt", text(range(1, 6)));
  commit("c10 add f.txt on feature branch");
  git("checkout", "-q", "main");
  git("merge", "--no-ff", "-m", "c11 merge feature (must be excluded from H-bar)", "feature");

  // c12: add files in nested directories (directory rollup ground truth).
  fs.mkdirSync(path.join(repoDir, "src", "app"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "src", "lib"), { recursive: true });
  write("src/app/main.txt", text(range(1, 5)));
  write("src/lib/helper.txt", text(range(1, 3)));
  commit("c12 add src/app/main.txt and src/lib/helper.txt");

  // c13: src/lib/helper.txt +2 -1.
  write("src/lib/helper.txt", text([...range(1, 1), ...range(3, 5)]));
  commit("c13 edit src/lib/helper.txt (+2 -1)");

  // c14: delete src/app/main.txt. Deletion records removed lines on its path,
  // rolled up through src/app, src and the root.
  git("rm", "-q", "src/app/main.txt");
  commit("c14 delete src/app/main.txt (-5)");

  // c15: add a file three levels deep (recursive rollup through deep/one/two).
  fs.mkdirSync(path.join(repoDir, "deep", "one", "two"), { recursive: true });
  write("deep/one/two/leaf.txt", text(range(1, 2)));
  commit("c15 add deep/one/two/leaf.txt (2)");

  // c16: move src/lib/helper.txt -> src/support/helper.txt with a small edit (+1 -1).
  // Hard rule: only the edit counts, attributed to the NEW directory chain.
  fs.mkdirSync(path.join(repoDir, "src", "support"), { recursive: true });
  fs.renameSync(
    path.join(repoDir, "src", "lib", "helper.txt"),
    path.join(repoDir, "src", "support", "helper.txt"),
  );
  write("src/support/helper.txt", text(range(2, 5)));
  commit("c16 move helper.txt to src/support with edit (+1 -1)");

  // c17: pure rename of a BINARY file. Hard rule: binaries are never measured,
  // so this commit must produce no rows at all (not even a docs/ rollup).
  fs.mkdirSync(path.join(repoDir, "docs"), { recursive: true });
  fs.renameSync(path.join(repoDir, "bin.dat"), path.join(repoDir, "docs", "bin.dat"));
  commit("c17 pure rename of binary file bin.dat to docs/bin.dat");

  // c18: add a file whose name needs C-quoting in git's text output.
  write('qu"ote.txt', text(range(1, 2)));
  commit("c18 add qu\"ote.txt (2 lines)");

  // c19: pure rename of the quoted file onto a name with a backslash. Only
  // exact raw-path handling attributes this rename to back\slash.txt.
  git("mv", 'qu"ote.txt', "back\\slash.txt");
  commit("c19 pure rename qu\"ote.txt to back\\slash.txt");

  return repoDir;
}

/** Zips a whole directory (including dotfiles like .git) for upload testing. */
export function zipDir(srcDir, zipPath) {
  const zip = new AdmZip();
  zip.addLocalFolder(srcDir);
  zip.writeZip(zipPath);
  return zipPath;
}
