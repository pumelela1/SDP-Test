/**
 * End-to-end smoke test. Requires a running server:
 *
 *   npm run dev           (or npm run build && npm start)
 *   npm run smoke         (defaults to http://localhost:3000)
 *   RAT_URL=http://localhost:3100 npm run smoke
 *
 * It builds a fixture repo with known metrics, zips it, uploads it over HTTP,
 * and checks the API + rendered page against the hand-computed values.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { EXPECTED, makeFixtureRepo, zipDir } from "../test/makeFixtureRepo.mjs";

const baseUrl = process.env.RAT_URL ?? "http://localhost:3000";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rat-smoke-"));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  const repoDir = path.join(tmp, "repo");
  makeFixtureRepo(repoDir);
  const zipPath = zipDir(repoDir, path.join(tmp, "repo.zip"));

  const form = new FormData();
  form.set("file", new Blob([fs.readFileSync(zipPath)], { type: "application/zip" }), "repo.zip");
  form.set("name", "smoke fixture");

  const upload = await fetch(`${baseUrl}/api/repos`, { method: "POST", body: form });
  const uploadBody = await upload.json().catch(() => ({}));
  check("POST /api/repos uploads and ingests", upload.status === 201, `HTTP ${upload.status}`);
  if (!upload.ok) {
    check("smoke run completed", false, JSON.stringify(uploadBody));
    throw new Error("upload failed");
  }

  const { repoId, commitCount } = uploadBody;
  check(
    "commit count (non-merge commits, merge excluded)",
    commitCount === EXPECTED.commitCount,
    `${commitCount} vs expected ${EXPECTED.commitCount}`,
  );

  const metricsResponse = await fetch(`${baseUrl}/api/repos/${repoId}/metrics`);
  const metrics = await metricsResponse.json();

  const totalsMatch =
    metrics.totals.added === EXPECTED.totals.added &&
    metrics.totals.removed === EXPECTED.totals.removed &&
    metrics.totals.growth === EXPECTED.totals.growth &&
    metrics.totals.churn === EXPECTED.totals.churn;
  check(
    "repo totals (added / removed / growth / churn)",
    totalsMatch,
    `${JSON.stringify(metrics.totals)} vs expected ${JSON.stringify(EXPECTED.totals)}`,
  );

  const byPath = Object.fromEntries(
    metrics.files.map((f) => [f.path, { added: f.added, removed: f.removed }]),
  );
  let filesMatch = Object.keys(EXPECTED.files).length === metrics.files.length;
  for (const [filePath, expected] of Object.entries(EXPECTED.files)) {
    const got = byPath[filePath];
    if (!got || got.added !== expected.added || got.removed !== expected.removed) {
      filesMatch = false;
    }
  }
  check(
    "per-file totals (rename / delete / binary hard rules)",
    filesMatch,
    JSON.stringify(byPath),
  );
  check("binary file is not measured", byPath["bin.dat"] === undefined);

  const byDir = Object.fromEntries(
    (metrics.directories ?? []).map((d) => [d.path, { added: d.added, removed: d.removed }]),
  );
  let dirsMatch = Object.keys(EXPECTED.directories).length === (metrics.directories ?? []).length;
  for (const [dirPath, expected] of Object.entries(EXPECTED.directories)) {
    const got = byDir[dirPath];
    if (!got || got.added !== expected.added || got.removed !== expected.removed) {
      dirsMatch = false;
    }
  }
  check(
    "directory rollup (recursive, root = repo)",
    dirsMatch,
    JSON.stringify(byDir),
  );

  const repo = metrics.repoTotals ?? {};
  check(
    "repo metrics equal the root rollup and the file sums",
    repo.added === EXPECTED.totals.added &&
      repo.removed === EXPECTED.totals.removed &&
      repo.growth === EXPECTED.totals.growth &&
      repo.churn === EXPECTED.totals.churn &&
      repo.added === metrics.totals.added &&
      repo.removed === metrics.totals.removed,
    JSON.stringify(repo),
  );

  const page = await fetch(`${baseUrl}/repos/${repoId}`);
  const html = await page.text();
  check(
    "dashboard page renders the table",
    page.status === 200 && html.includes("d.txt") && html.includes("Churn"),
    `HTTP ${page.status}`,
  );
  check(
    "dashboard page renders the directory rollup",
    page.status === 200 && html.includes("(repo root)") && html.includes("src/lib"),
    `HTTP ${page.status}`,
  );

  const badForm = new FormData();
  badForm.set("file", new Blob([Buffer.from("not a zip")], { type: "application/zip" }), "bad.zip");
  const badUpload = await fetch(`${baseUrl}/api/repos`, { method: "POST", body: badForm });
  const badBody = await badUpload.json().catch(() => ({}));
  check(
    "invalid upload rejected with a friendly error",
    badUpload.status === 400 && typeof badBody.error === "string",
    badBody.error ?? `HTTP ${badUpload.status}`,
  );
} catch (err) {
  console.error(`Smoke test aborted: ${err instanceof Error ? err.message : err}`);
  results.push({ name: "smoke run completed", ok: false });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
