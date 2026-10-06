import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

// Fixed commit timestamps so commit-set filters stay deterministic.
const BASE_TIME = 1700000000;

const ANN = { name: "Ann A", email: "ann@corp.example" };
const ANN_ALT = { name: "ann.work", email: "ann@personal.example" }; // maps to ANN (email rule)
const BOB = { name: "Bob B", email: "bob@corp.example" };
const BOB_ALT = { name: "Bobby", email: "bob@old.example" }; // maps to BOB (full-identity rule)

/**
 * The .mailmap committed at the tip: every commit of ANN_ALT / BOB_ALT is
 * re-attributed to ANN / BOB by git itself (%aN/%aE), which is what the
 * ingest pipeline stores as the canonical author h[a].
 */
export const MAILMAP = [
  `Ann A <${ANN.email}> <${ANN_ALT.email}>`,
  `Bob B <${BOB.email}> ${BOB_ALT.name} <${BOB_ALT.email}>`,
].join("\n");

/**
 * Hand-computed author metrics for the scripted commits below, over all of
 * H-bar (9 commits) and with the .mailmap applied.
 */
export const AUTHOR_EXPECTED = {
  commitCount: 9,
  // c9 adds the .mailmap itself, so it is a measured text file (+2).
  mailmapMergedCommits: 4, // c2, c4, c8 (ann.work) and c5 (Bobby)
  totalChurn: 35, // a.txt 16 + b.txt 9 + src/x.txt 8 + .mailmap 2 + c.txt 0
  authors: {
    [ANN.email]: {
      name: "Ann A",
      email: ANN.email,
      commits: 6, // c1, c2, c4, c6, c8, c9
      added: 20,
      removed: 6,
      growth: 14,
      churn: 26,
      ownership: 26 / 35,
    },
    [BOB.email]: {
      name: "Bob B",
      email: BOB.email,
      commits: 3, // c3, c5, c7
      added: 8,
      removed: 1,
      growth: 7,
      churn: 9,
      ownership: 9 / 35,
    },
  },
  // Per-object author metrics: mods n, churn λ, ownership ω.
  objects: {
    "a.txt": { churn: 16, authors: { [ANN.email]: { modifications: 3, churn: 16, ownership: 1 } } },
    "b.txt": { churn: 9, authors: { [BOB.email]: { modifications: 2, churn: 9, ownership: 1 } } },
    // c7 is a pure rename onto c.txt: the row exists but ω = 0 when λ = 0.
    "c.txt": { churn: 0, authors: { [BOB.email]: { modifications: 0, churn: 0, ownership: 0 } } },
    "src/x.txt": { churn: 8, authors: { [ANN.email]: { modifications: 2, churn: 8, ownership: 1 } } },
    ".mailmap": { churn: 2, authors: { [ANN.email]: { modifications: 1, churn: 2, ownership: 1 } } },
    src: { churn: 8, authors: { [ANN.email]: { modifications: 2, churn: 8, ownership: 1 } } },
    ".": {
      churn: 35,
      authors: {
        [ANN.email]: { modifications: 6, churn: 26, ownership: 26 / 35 }, // c1..c9 except c7
        [BOB.email]: { modifications: 2, churn: 9, ownership: 9 / 35 }, // c3, c5 (c7 has λ=0)
      },
    },
  },
  // The same repository ingested WITHOUT any .mailmap: raw identities stay
  // distinct authors (I(a,h) = 1 iff a equals the commit's own identity).
  withoutMailmap: {
    commitCount: 8, // c9 only adds the .mailmap, so it does not exist here
    totalChurn: 33,
    authors: {
      [ANN.email]: { commits: 2, churn: 14, ownership: 14 / 33 }, // c1 +10, c6 -4
      [ANN_ALT.email]: { commits: 3, churn: 10, ownership: 10 / 33 }, // c2, c4, c8
      [BOB.email]: { commits: 2, churn: 6, ownership: 6 / 33 }, // c3, c7
      [BOB_ALT.email]: { commits: 1, churn: 3, ownership: 3 / 33 }, // c5
    },
  },
};

const line = (n) => `line ${n}`;
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const text = (numbers) => numbers.map(line).join("\n") + "\n";

/**
 * Builds the author-metrics fixture: two authors each committing under two
 * identities, with a .mailmap committed at the tip that merges them.
 * `withMailmap: false` skips the .mailmap commit entirely.
 */
export function makeAuthorFixtureRepo(repoDir, { withMailmap = true } = {}) {
  fs.mkdirSync(repoDir, { recursive: true });

  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  let commitIndex = 0;
  const commitAs = (author, message) => {
    commitIndex += 1;
    const stamp = `${BASE_TIME + commitIndex * 3600} +0000`;
    git("add", "-A");
    execFileSync("git", ["commit", "-q", "-m", message], {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: "Committer",
        GIT_COMMITTER_EMAIL: "committer@example.com",
        GIT_AUTHOR_DATE: stamp,
        GIT_COMMITTER_DATE: stamp,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  const write = (rel, content) => fs.writeFileSync(path.join(repoDir, rel), content);

  git("init", "-q", "-b", "main");

  // c1: Ann adds a.txt (10 lines).
  write("a.txt", text(range(1, 10)));
  commitAs(ANN, "c1 add a.txt (10)");

  // c2: ann.work edits a.txt (+3 -1).
  write("a.txt", text([...range(1, 9), ...range(11, 13)]));
  commitAs(ANN_ALT, "c2 edit a.txt (+3 -1)");

  // c3: Bob adds b.txt (6 lines).
  write("b.txt", text(range(1, 6)));
  commitAs(BOB, "c3 add b.txt (6)");

  // c4: ann.work adds src/x.txt (4 lines).
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  write("src/x.txt", text(range(1, 4)));
  commitAs(ANN_ALT, "c4 add src/x.txt (4)");

  // c5: Bobby edits b.txt (+2 -1).
  write("b.txt", text([...range(2, 6), ...range(7, 8)]));
  commitAs(BOB_ALT, "c5 edit b.txt (+2 -1)");

  // c6: Ann deletes src/x.txt (-4).
  git("rm", "-q", "src/x.txt");
  commitAs(ANN, "c6 delete src/x.txt (-4)");

  // c7: Bob pure-renames b.txt -> c.txt (no churn on c.txt, but an author row).
  git("mv", "b.txt", "c.txt");
  commitAs(BOB, "c7 pure rename b.txt to c.txt");

  // c8: ann.work edits a.txt (+1 -1).
  write("a.txt", text([0, ...range(2, 9), ...range(11, 13)]));
  commitAs(ANN_ALT, "c8 edit a.txt (+1 -1)");

  // c9: Ann commits the .mailmap itself (a measured 2-line text file).
  if (withMailmap) {
    write(".mailmap", MAILMAP + "\n");
    commitAs(ANN, "c9 add .mailmap");
  }

  return repoDir;
}

/** Zips a whole directory (including dotfiles like .git) for upload testing. */
export function zipDir(srcDir, zipPath) {
  const zip = new AdmZip();
  zip.addLocalFolder(srcDir);
  zip.writeZip(zipPath);
  return zipPath;
}
