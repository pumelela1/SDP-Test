/**
 * End-to-end smoke test. Requires a running server:
 *
 *   npm run dev           (or npm run build && npm start)
 *   npm run smoke         (defaults to http://localhost:3000)
 *   RAT_URL=http://localhost:3100 npm run smoke
 *
 * It builds a fixture repo with known metrics, zips it, uploads it over HTTP,
 * then clones the same repo from a file:// URL, and checks the API + rendered
 * page against the hand-computed values (plus error handling: bad zip, bad
 * URL, and file/URL form validation).
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

  // Author metrics: the fixture has a single author owning everything.
  const authorMetrics = metrics.authorMetrics ?? {};
  const singleAuthor =
    Array.isArray(authorMetrics.authors) &&
    authorMetrics.authors.length === 1 &&
    authorMetrics.authors[0].name === "Fixture Author" &&
    authorMetrics.authors[0].churn === EXPECTED.totals.churn &&
    authorMetrics.authors[0].ownership === 1;
  check(
    "author leaderboard (single author, full ownership)",
    singleAuthor,
    JSON.stringify(authorMetrics.authors ?? null),
  );

  const dTxt = (metrics.files ?? []).find((f) => f.path === "d.txt");
  check(
    "per-object top author attached to file rows",
    dTxt !== undefined &&
      dTxt.topAuthor !== null &&
      dTxt.topAuthor.name === "Fixture Author" &&
      dTxt.topAuthor.ownership === 1,
    JSON.stringify(dTxt?.topAuthor ?? null),
  );

  const objectDetail = await fetch(
    `${baseUrl}/api/repos/${repoId}/metrics?object=${encodeURIComponent("d.txt")}`,
  );
  const objectBody = await objectDetail.json();
  check(
    "per-object author metrics endpoint (?object=)",
    objectDetail.status === 200 &&
      objectBody.authorMetrics?.object?.path === "d.txt" &&
      objectBody.authorMetrics.object.authors[0].churn === 7,
    JSON.stringify(objectBody.authorMetrics?.object ?? null),
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
  check(
    "dashboard page renders the author metrics",
    page.status === 200 && html.includes("Author metrics") && html.includes("Fixture Author"),
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

  // URL ingestion: file:// runs the same clone transport as https://.
  const urlForm = new FormData();
  urlForm.set("url", `file://${repoDir}`);
  urlForm.set("name", "smoke clone");
  const urlUpload = await fetch(`${baseUrl}/api/repos`, { method: "POST", body: urlForm });
  const urlBody = await urlUpload.json().catch(() => ({}));
  check(
    "POST /api/repos clones a URL and ingests",
    urlUpload.status === 201 && typeof urlBody.repoId === "number",
    `HTTP ${urlUpload.status} ${JSON.stringify(urlBody)}`,
  );
  if (typeof urlBody.repoId === "number") {
    const urlMetrics = await (await fetch(`${baseUrl}/api/repos/${urlBody.repoId}/metrics`)).json();
    check(
      "URL clone yields the same totals as the zip upload",
      urlMetrics.totals.added === EXPECTED.totals.added &&
        urlMetrics.totals.removed === EXPECTED.totals.removed &&
        urlMetrics.totals.churn === EXPECTED.totals.churn &&
        urlBody.commitCount === EXPECTED.commitCount,
      `${JSON.stringify(urlMetrics.totals)} vs expected ${JSON.stringify(EXPECTED.totals)}`,
    );
  }

  const bothForm = new FormData();
  bothForm.set("file", new Blob([fs.readFileSync(zipPath)], { type: "application/zip" }), "repo.zip");
  bothForm.set("url", `file://${repoDir}`);
  const bothUpload = await fetch(`${baseUrl}/api/repos`, { method: "POST", body: bothForm });
  const bothBody = await bothUpload.json().catch(() => ({}));
  check(
    "file + url together rejected with a friendly error",
    bothUpload.status === 400 && typeof bothBody.error === "string",
    bothBody.error ?? `HTTP ${bothUpload.status}`,
  );

  const neitherUpload = await fetch(`${baseUrl}/api/repos`, {
    method: "POST",
    body: new FormData(),
  });
  const neitherBody = await neitherUpload.json().catch(() => ({}));
  check(
    "empty upload rejected with a friendly error",
    neitherUpload.status === 400 && typeof neitherBody.error === "string",
    neitherBody.error ?? `HTTP ${neitherUpload.status}`,
  );

  const badUrlForm = new FormData();
  badUrlForm.set("url", "file:///definitely/not/a/repo.git");
  const badUrlUpload = await fetch(`${baseUrl}/api/repos`, { method: "POST", body: badUrlForm });
  const badUrlBody = await badUrlUpload.json().catch(() => ({}));
  check(
    "failed clone rejected with a friendly error",
    badUrlUpload.status === 400 &&
      typeof badUrlBody.error === "string" &&
      /failed/i.test(badUrlBody.error),
    badUrlBody.error ?? `HTTP ${badUrlUpload.status}`,
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
