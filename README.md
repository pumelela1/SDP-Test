# RAT — Repo Analysis Tool

Add a repository in two forms: upload a `.zip` of a Git repository (with its `.git`
directory), or paste a remote URL that is deep-cloned with `git clone --mirror`. The
full history is ingested once with `git log --numstat -z`, per-commit file deltas plus
the per-commit directory rollup are stored in SQLite, and per-file / per-directory /
repository metrics (added / removed / growth / churn) are served over the whole commit
set (the root rollup is the repository metric).

## Hard rules enforced at ingest

- **H̄ = non-merge commits reachable from HEAD** (`--no-merges`); merge commits are excluded.
- **Rename detection at 50%** (`--find-renames=50%`): a pure rename changes no metrics;
  a rename + edit counts only the edit, attributed to the **new** path. The log is read in
  git's NUL-separated `-z` numstat form, which reports raw old/new paths with no quoting or
  brace compression — attribution stays exact for any filename (quotes, backslashes, tabs).
- **Deleting a file** records its lines as removed on that path. (A file that disappears
  only in a merge or subtree import has no deletion in any H̄ commit, so it records none —
  e.g. cJSON's `tests/unity` lineage moves files inside the excluded merge.)
- **Binary files are not measured** (git's `-` numstat rows are dropped, renamed binaries
  included).
- **Committer date** is stored per commit; the author identity is stored twice — raw
  (`%an`/`%ae`) and canonical (`%aN`/`%aE`, the repository's `.mailmap` applied by git
  itself at ingest). Every author metric uses the canonical identity `h[a]`; the raw one is
  kept so a later manual merge can re-map it.
- **`.mailmap` is auto-applied**: a `.mailmap` file in the worktree is read by git directly;
  a `.mailmap` committed at the reference commit is applied via `mailmap.blob=HEAD:.mailmap`
  (the usual case for a zip that carries only the `.git` directory — and always the case for
  a URL ingestion, because a `--mirror` clone is bare and has no worktree). The ingest always
  runs with `-C` inside the repository so an unrelated `.mailmap` in the server's working
  directory can never leak into the metrics.
- **URL ingestion deep-clones**: `git clone --mirror` (bare, every ref copied, full
  history) into a temp directory that is ingested by the same pipeline and deleted
  afterwards; the reference commit is the clone's `HEAD`. A failed clone surfaces git's
  own `fatal:` message and leaves no repository row behind.
- **Initial commit** (h[p] = empty commit) is diffed against the empty tree, so all its
  lines count as added.
- **Directory metrics are a recursive rollup materialized at ingest**: a directory's
  l+ / l− / δ / λ is the sum over its immediate child files and subdirectories (so it
  already contains every file below it). The root is stored as `.`, making the root row
  the repository metrics.
- **Author metrics** (section 2.5 of the brief) are SQL aggregations over the stored
  per-commit deltas: author modifications n = Σ I(a,h)·I_n(h,o) (commits of the author
  with churn on the object), author churn λ_a = Σ λ_{h,o}·I(a,h), and ownership
  ω = λ_a / λ_o (0 when the object's churn is 0). Author metrics follow the same
  commit-set filters as every other metric.

Not implemented yet (later steps): manual author-merge UI, multi-repo UX, charts.

## Requirements

- Node.js 18.18+ and npm
- `git` on PATH

> Note for this machine (Ubuntu 24.04 / Node 18.19.1): Ubuntu's node reports ABI 109
> (`libnode109`), so official better-sqlite3 prebuilds cannot load and the module is
> compiled from source against the system headers on install. If you ever delete
> `node_modules`, reinstall with the system Python:
>
> ```bash
> PYTHON=/usr/bin/python3 npm install
> ```

## Install

```bash
npm install
```

## Run (development)

```bash
npm run dev
# open http://localhost:3000
```

## Run (production)

```bash
npm run build
npm start
```

## Automated tests

Parser unit tests + rollup unit tests + ingest integration tests (builds a real fixture repo
with hand-computed metrics: edits, pure rename, rename+edit, delete, binary add, binary
rename, quoted-filename add and rename, merge commit exclusion, nested-directory rollup
incl. create-then-delete) + commit-set filter tests + author-metrics tests (a fixture with
two authors committing under two identities each and a committed `.mailmap` merging them;
also verifies the in-place database migration and that an ambient `.mailmap` in the cwd
never leaks in) + URL-ingestion tests (`git clone --mirror` over `file://` must yield
metrics identical to the zip path, the bare mirror's committed `.mailmap` must be applied,
and a failed clone must leave no row). The ingest test also cross-checks the stored totals
against raw `git log --numstat` text-mode output parsed independently.
No server needed; requires `git`.

```bash
npm test
```

## End-to-end smoke test (server must already be running)

Builds a fixture repo, zips it, uploads it over HTTP, then checks the API and the rendered
page against the same hand-computed numbers (also checks error handling on a bad upload,
URL cloning over `file://`, and the file/URL/neither/both form validation).

```bash
npm run smoke                                # defaults to http://localhost:3000
RAT_URL=http://localhost:3100 npm run smoke  # or another port
```

The smoke test leaves a repository named "smoke fixture" in the dashboard.
To reset all stored data, stop the server and delete the `data/` folder.

## Manual test: ingest a real repository

### Form 1 — zip upload

1. Clone a repository with full history:

   ```bash
   git clone https://github.com/DaveGamble/cJSON.git /tmp/cJSON
   ```

2. Zip it, **including the `.git` directory**:

   ```bash
   cd /tmp/cJSON && zip -qr /tmp/cJSON.zip .
   # alternative if `zip` is not installed:
   # python3 -c "import shutil; shutil.make_archive('/tmp/cJSON','zip','/tmp/cJSON')"
   ```

3. Open http://localhost:3000, choose `/tmp/cJSON.zip`, click **Upload & ingest**.
   You should land on the repository page with the totals cards and the per-file table.

### Form 2 — clone URL

1. Open http://localhost:3000, paste
   `https://github.com/DaveGamble/cJSON.git` into the **…or clone URL** field,
   click **Clone & ingest**. The repository is deep-cloned server-side with
   `git clone --mirror`; with the display name left blank the name is derived from
   the URL (`cJSON`). Leave the zip field empty — filling both is rejected.

2. Error handling: a URL that cannot be cloned (typo, private repo, no network)
   shows git's own error and no repository is added.

The numeric sanity checks below apply to either form.

### Sanity-check the numbers against raw git

   ```bash
   git -C /tmp/cJSON log --no-merges --find-renames=50% --numstat --format= \
     | awk -F'\t' 'NF==3 && $1!="-"{a+=$1; r+=$2} END {print "added="a, "removed="r}'
   ```

   Compare with the "Added lines" / "Removed lines" cards (growth = added − removed,
   churn = added + removed). The reference clone used during development gave
   `added=46377 removed=11211`.

   A single file must also be summed from the full diff, attributing renames to the
   target (new) path. A plain `git log --numstat -- <path>` (pathspec view) is *not*
   equivalent: history simplification can hide whole side branches (e.g. the
   `git subtree --squash` lineage behind cJSON's `tests/unity/`), and renames touching
   the path appear there as whole-file adds:

   ```bash
   git -C /tmp/cJSON log --no-merges --find-renames=50% --numstat --format= \
     | awk -F'\t' -v want="cJSON.c" 'NF==3 && $1!="-" {
         p = $3
         if (index(p, "=>")) {                       # rename row: use the new path
           if (index(p, "{")) {                      # dir/{old => new}/file
             pre = p;  sub(/\{.*/, "", pre)
             post = p; sub(/^.*\}/, "", post)
             m = p;    sub(/^.*\{/, "", m); sub(/\}.*/, "", m)
             n = split(m, mid, " => "); p = pre mid[n] post
           } else { n = split(p, mid, " => "); p = mid[n] }
         }
         if (p == want) { a += $1; r += $2 }
       } END { print "added="a, "removed="r }'
   ```

   For the reference clone: `want="cJSON.c"` → `added=8165 removed=4457`;
   `want="README.md"` → `added=1351 removed=702` (renamed from `README` at some
   point in history — the pure-rename commit contributes 0/0 and the later lines
   are attributed to `README.md`, per the hard rules).

   Directory metrics use the same sums restricted to everything below a directory:
   for a directory `d`, sum the rows whose (rename-resolved) path starts with `d/`
   — e.g. replace the `p == want` test above with `index(p, want "/") == 1`. The
   root is every row, so it matches the repo-wide numbers above and the "Added
   lines" / "Removed lines" cards. Sanity-check the directory table on the
   repository page this way (e.g. `tests/unity` for cJSON).

   Author metrics can be checked against git's own mailmapped identities
   (`%aN`/`%aE` are exactly what the tool stores): the leaderboard's commit counts
   must match this, and each author's added/removed/churn sums must match the
   same sums restricted to that author's commits in the unfiltered numstat stream:

   ```bash
   git -C /tmp/cJSON log --no-merges --format='%aN <%aE>' | sort | uniq -c | sort -rn | head
   ```

   Repositories whose `.mailmap` is only committed (not checked out) — e.g. a zip
   of just the `.git` directory, or any URL ingestion (a `--mirror` clone is bare) —
   are merged the same way; `git log` reads a committed `.mailmap` with
   `-c mailmap.blob=HEAD:.mailmap`, which is exactly what the ingest passes to git.

Error handling: upload a non-zip file, a zip without `.git`, or a URL that cannot be
cloned — the form shows a red error and no repository is added.

## HTTP API (used by the smoke test)

```bash
# zip upload + ingest (multipart form: file=@repo.zip, optional name=...)
curl -sS -F "file=@/tmp/cJSON.zip" -F "name=cJSON" http://localhost:3000/api/repos

# URL ingestion (multipart form: url=<remote>, optional name=...; deep clone via --mirror)
curl -sS -F "url=https://github.com/DaveGamble/cJSON.git" http://localhost:3000/api/repos

# list repositories
curl -sS http://localhost:3000/api/repos

# per-file metrics, per-directory rollup and root (= repo) totals for one repository
curl -sS http://localhost:3000/api/repos/1/metrics

# author metrics of a single file or directory (per-author mods n / churn λ / ownership ω)
curl -sS "http://localhost:3000/api/repos/1/metrics?object=cJSON.c"
```

The metrics response contains `files` (per path, each with its `topAuthor`), `directories`
(recursive rollup, the root row is `.`; each with its `topAuthor`), `totals` (file sums),
`repoTotals` (the root rollup) and `authorMetrics`:

- `authorMetrics.authors` — the author leaderboard (the root object's author metrics):
  commits (Σ I(a,h)), added/removed/growth, churn λ and ownership ω per canonical author
- `authorMetrics.mailmapMergedCommits` — how many commits the `.mailmap` re-attributed
- `authorMetrics.object` — present with `?object=<path>`: per-author mods n, churn λ and
  ownership ω on that one file or directory

All of them follow the same commit-set filter query parameters as the other metrics
(`mode=period&from=…&to=…`, `mode=commits&commit=…`).

## Project layout

```
app/                        Next.js App Router pages + API routes
  api/repos/route.ts        POST upload+ingest (zip file or clone URL), GET list
  api/repos/[id]/metrics/   GET file + directory + repo + author metrics (JSON)
  repos/[id]/page.tsx       repository dashboard (cards + author + directory + file tables)
components/UploadForm.tsx   client upload/clone form (zip file or repository URL)
lib/
  db.ts                     SQLite connection + schema + in-place migrations (better-sqlite3)
  queries.ts                SQL for file/directory/repo/commit-set and author metrics
  rollup.ts                 pure recursive rollup (file deltas -> directory deltas, root = ".")
  git/parseLog.ts           pure parser for `git log --numstat` output
  git/gitcli.ts             locate the repo in an extract, locate its .mailmap, run git,
                             deep-clone a remote URL (git clone --mirror)
  git/ingest.ts             zip extract / mirror clone -> parse -> rollup -> store (the pipeline)
test/                       node:test unit + integration tests (fixture repos)
scripts/smoke.mjs           HTTP end-to-end smoke test
data/                       SQLite database (gitignored, created on first run)
```

## Environment variables

- `RAT_DB_PATH` — SQLite file location (default: `data/rat.db`)
- `RAT_URL` — base URL used by the smoke test (default: `http://localhost:3000`)
