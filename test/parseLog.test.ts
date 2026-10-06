import assert from "node:assert/strict";
import test from "node:test";
import {
  parseGitLog,
  quotedRenameNewPath,
  renameTargetPath,
  resolveNumstatPath,
  unquoteGitPath,
} from "../lib/git/parseLog.ts";

const NUL = "\0";
const FIELD_SEP = "\x02";

function commitLine(
  sha: string,
  parents: string,
  ts: number,
  name = "Ann",
  email = "ann@example.com",
  canonicalName?: string,
  canonicalEmail?: string,
): string {
  const mapped =
    canonicalName === undefined ? "" : `${FIELD_SEP}${canonicalName}${FIELD_SEP}${canonicalEmail}`;
  return `\x01${sha}${FIELD_SEP}${parents}${FIELD_SEP}${ts}${FIELD_SEP}${name}${FIELD_SEP}${email}${mapped}`;
}

test("parses commit headers and numstat rows (-z stream)", () => {
  const log = [
    commitLine("abc123", "def456", 1700000000),
    "12\t0\tnew.txt",
    "3\t8\told.txt",
    "\n" + commitLine("def456", "", 1699990000, "Bob", "bob@example.com"),
    "5\t0\tfirst.txt",
  ].join(NUL);

  const commits = parseGitLog(log);
  assert.equal(commits.length, 2);

  assert.deepEqual(commits[0], {
    sha: "abc123",
    parentSha: "def456",
    committerTs: 1700000000,
    authorName: "Ann",
    authorEmail: "ann@example.com",
    canonicalName: "Ann",
    canonicalEmail: "ann@example.com",
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

test("keeps the .mailmap-mapped author identity (%aN/%aE) next to the raw one", () => {
  const log = [
    commitLine("abc", "def", 1, "ann.laptop", "ann@personal.example", "Ann", "ann@corp.example"),
    "1\t0\ta.txt",
  ].join(NUL);

  const [commit] = parseGitLog(log);
  assert.equal(commit.authorName, "ann.laptop");
  assert.equal(commit.authorEmail, "ann@personal.example");
  assert.equal(commit.canonicalName, "Ann");
  assert.equal(commit.canonicalEmail, "ann@corp.example");
});

test("skips binary rows (git numstat marks them with '-')", () => {
  const log = [commitLine("abc", "def", 1), "-\t-\timage.png", "1\t0\ttext.txt"].join(NUL);
  const commits = parseGitLog(log);
  assert.equal(commits[0].binaryFileCount, 1);
  assert.deepEqual(commits[0].files, [{ path: "text.txt", added: 1, removed: 0 }]);
});

test("attributes renames to the new path (raw old/new fields)", () => {
  const log = [
    commitLine("abc", "def", 1),
    "0\t0\t",
    "a.txt",
    "b.txt",
    "5\t2\t",
    "dir/old name.txt",
    "dir/new name.txt",
    "1\t0\tadded.txt",
  ].join(NUL);

  const [commit] = parseGitLog(log);
  assert.deepEqual(commit.files, [
    { path: "b.txt", added: 0, removed: 0 }, // pure rename: no metrics, new path
    { path: "dir/new name.txt", added: 5, removed: 2 }, // rename+edit on new path
    { path: "added.txt", added: 1, removed: 0 },
  ]);
});

test("drops renamed binaries but still counts them", () => {
  const log = [
    commitLine("abc", "def", 1),
    "-\t-\t",
    "old.png",
    "new.png",
    "2\t1\ttext.txt",
  ].join(NUL);

  const [commit] = parseGitLog(log);
  assert.equal(commit.binaryFileCount, 1);
  assert.deepEqual(commit.files, [{ path: "text.txt", added: 2, removed: 1 }]);
});

test("keeps raw filenames with tabs, quotes and backslashes (-z never quotes)", () => {
  const log = [
    commitLine("abc", "def", 1),
    "3\t1\twe\tird\"name\\path.txt",
    "0\t0\t",
    'quo"te.txt',
    "back\\slash.txt",
  ].join(NUL);

  const [commit] = parseGitLog(log);
  assert.deepEqual(commit.files, [
    { path: "we\tird\"name\\path.txt", added: 3, removed: 1 },
    { path: "back\\slash.txt", added: 0, removed: 0 },
  ]);
});

test("empty commits and a trailing NUL produce no file rows", () => {
  const log = [commitLine("abc", "", 1), "\n" + commitLine("def", "abc", 2), ""].join(NUL);
  const commits = parseGitLog(log);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0].files, []);
  assert.deepEqual(commits[1].files, []);
});

test("maps text-mode rename displays to the new path", () => {
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

test("resolves the quoted rename pair form git uses for unquotable names", () => {
  // git prints `"old" => "new"` (each side C-quoted, never brace-compressed)
  // when either path needs quoting.
  assert.equal(
    quotedRenameNewPath('"we\\"ird.txt" => "back\\\\slash.txt"'),
    "back\\slash.txt",
  );
  assert.equal(quotedRenameNewPath("plain.txt => new.txt"), null);
  assert.equal(
    resolveNumstatPath('"we\\"ird.txt" => "back\\\\slash.txt"'),
    "back\\slash.txt",
  );
  assert.equal(resolveNumstatPath("src/{old => new}/f.txt"), "src/new/f.txt");
  assert.equal(resolveNumstatPath('"caf\\303\\251.txt" => "caf\\303\\252.txt"'), "cafê.txt");
});

test("composes unquoting and rename mapping", () => {
  assert.equal(renameTargetPath(unquoteGitPath('"dir/{old => new name}.txt"')), "dir/new name.txt");
});
