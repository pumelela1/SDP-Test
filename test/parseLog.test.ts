import assert from "node:assert/strict";
import test from "node:test";
import { parseGitLog, renameTargetPath, unquoteGitPath } from "../lib/git/parseLog.ts";

function commitLine(
  sha: string,
  parents: string,
  ts: number,
  name = "Ann",
  email = "ann@example.com",
): string {
  return `\x01${sha}\x02${parents}\x02${ts}\x02${name}\x02${email}`;
}

test("parses commit headers and numstat rows", () => {
  const log = [
    commitLine("abc123", "def456", 1700000000),
    "",
    "12\t0\tnew.txt",
    "3\t8\told.txt",
    commitLine("def456", "", 1699990000, "Bob", "bob@example.com"),
    "",
    "5\t0\tfirst.txt",
    "",
  ].join("\n");

  const commits = parseGitLog(log);
  assert.equal(commits.length, 2);

  assert.deepEqual(commits[0], {
    sha: "abc123",
    parentSha: "def456",
    committerTs: 1700000000,
    authorName: "Ann",
    authorEmail: "ann@example.com",
    files: [
      { path: "new.txt", added: 12, removed: 0 },
      { path: "old.txt", added: 3, removed: 8 },
    ],
    binaryFileCount: 0,
  });

  // Initial commit: h[p] = empty commit => no parent sha.
  assert.equal(commits[1].parentSha, null);
  assert.deepEqual(commits[1].files, [{ path: "first.txt", added: 5, removed: 0 }]);
});

test("skips binary rows (git numstat marks them with '-')", () => {
  const log = [commitLine("abc", "def", 1), "", "-\t-\timage.png", "1\t0\ttext.txt"].join(
    "\n",
  );
  const commits = parseGitLog(log);
  assert.equal(commits[0].binaryFileCount, 1);
  assert.deepEqual(commits[0].files, [{ path: "text.txt", added: 1, removed: 0 }]);
});

test("maps renames to the new path", () => {
  assert.equal(renameTargetPath("old.txt => new.txt"), "new.txt");
  assert.equal(renameTargetPath("src/{old => new}/f.txt"), "src/new/f.txt");
  assert.equal(renameTargetPath("{old => new}.txt"), "new.txt");
  assert.equal(renameTargetPath("unchanged.txt"), "unchanged.txt");
});

test("unquotes git-quoted paths", () => {
  assert.equal(unquoteGitPath('"a\\tb.txt"'), "a\tb.txt");
  assert.equal(unquoteGitPath('"quote\\"d.txt"'), 'quote"d.txt');
  assert.equal(unquoteGitPath('"caf\\303\\251.txt"'), "café.txt");
  assert.equal(unquoteGitPath("plain.txt"), "plain.txt");
});

test("composes unquoting and rename mapping", () => {
  assert.equal(renameTargetPath(unquoteGitPath('"dir/{old => new name}.txt"')), "dir/new name.txt");
});
