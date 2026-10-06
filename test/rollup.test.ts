import assert from "node:assert/strict";
import test from "node:test";
import { ancestorDirectories, ROOT_DIR, rollupCommitDeltas } from "../lib/rollup.ts";

test("ancestorDirectories walks from the immediate parent up to the root", () => {
  assert.equal(ROOT_DIR, ".");
  assert.deepEqual(ancestorDirectories("c.txt"), ["."]);
  assert.deepEqual(ancestorDirectories("a/b.txt"), ["a", "."]);
  assert.deepEqual(ancestorDirectories("a/b/c.txt"), ["a/b", "a", "."]);
});

test("rollup sums every file into every ancestor directory (root included)", () => {
  const rows = rollupCommitDeltas([
    { path: "a/b.txt", added: 3, removed: 1 },
    { path: "a/c/d.txt", added: 10, removed: 5 },
    { path: "top.txt", added: 2, removed: 0 },
  ]);

  assert.deepEqual(rows, [
    { path: ".", added: 15, removed: 6 }, // repo metrics = root rollup
    { path: "a", added: 13, removed: 6 }, // b.txt + c/ (recursive)
    { path: "a/c", added: 10, removed: 5 },
  ]);
});

test("a rename + edit rolls up only the new path's directory chain", () => {
  // parseLog attributes renames to the new path, so only ancestors of src/support see it.
  const rows = rollupCommitDeltas([{ path: "src/support/helper.txt", added: 1, removed: 1 }]);

  assert.deepEqual(rows, [
    { path: ".", added: 1, removed: 1 },
    { path: "src", added: 1, removed: 1 },
    { path: "src/support", added: 1, removed: 1 },
  ]);
});

test("pure renames (+0 -0) and empty commits produce no directory rows", () => {
  assert.deepEqual(rollupCommitDeltas([{ path: "renamed.txt", added: 0, removed: 0 }]), []);
  assert.deepEqual(rollupCommitDeltas([]), []);
});
