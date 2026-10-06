# RAT — Repo Analysis Tool (step 0: walking skeleton)

Upload a `.zip` of a Git repository (with its `.git` directory), ingest the full history
once with `git log --numstat`, store per-commit file deltas in SQLite, and view per-file
added / removed / growth / churn over the whole commit set.

## Hard rules enforced at ingest

- **H̄ = non-merge commits reachable from HEAD** (`--no-merges`); merge commits are excluded.
- **Rename detection at 50%** (`--find-renames=50%`): a pure rename changes no metrics;
  a rename + edit counts only the edit, attributed to the **new** path.
- **Deleting a file** records its lines as removed on that path.
- **Binary files are not measured** (git's `-` numstat rows are dropped).
- **Committer date** is stored per commit; raw author name/email are kept for the later
  author-merge step.
- **Initial commit** (h[p] = empty commit) is diffed against the empty tree, so all its
  lines count as added.

Not implemented yet (later steps): directory/repo rollups, commit-set and author metrics,
filters, mailmap/manual author merge, URL cloning, multi-repo UX, charts.

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

Parser unit tests + ingest integration tests (builds a real fixture repo with hand-computed
metrics: edits, pure rename, rename+edit, delete, binary add, merge commit exclusion).
No server needed; requires `git`.

```bash
npm test
```

## End-to-end smoke test (server must already be running)

Builds a fixture repo, zips it, uploads it over HTTP, then checks the API and the rendered
page against the same hand-computed numbers (also checks error handling on a bad upload).

```bash
npm run smoke                                # defaults to http://localhost:3000
RAT_URL=http://localhost:3100 npm run smoke  # or another port
```

The smoke test leaves a repository named "smoke fixture" in the dashboard.
To reset all stored data, stop the server and delete the `data/` folder.

## Manual test: upload a real repository

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

4. Sanity-check the numbers against raw git. Repo-wide totals (full diff, no pathspec —
   the exact command family the tool stores):

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

5. Error handling: upload a non-zip file, or a zip without `.git` — the form shows a red
   error and no repository is added.

## HTTP API (used by the smoke test)

```bash
# upload + ingest (multipart form: file=@repo.zip, optional name=...)
curl -sS -F "file=@/tmp/cJSON.zip" -F "name=cJSON" http://localhost:3000/api/repos

# list repositories
curl -sS http://localhost:3000/api/repos

# per-file metrics for one repository
curl -sS http://localhost:3000/api/repos/1/metrics
```

## Project layout

```
app/                        Next.js App Router pages + API routes
  api/repos/route.ts        POST upload+ingest, GET list
  api/repos/[id]/metrics/   GET per-file metrics (JSON)
  repos/[id]/page.tsx       repository dashboard (totals + per-file table)
components/UploadForm.tsx   client upload form
lib/
  db.ts                     SQLite connection + schema (better-sqlite3)
  queries.ts                SQL for per-file commit-set totals
  git/parseLog.ts           pure parser for `git log --numstat` output
  git/gitcli.ts             locate the repo in an extract, run git
  git/ingest.ts             zip extract -> parse -> store (the pipeline)
test/                       node:test unit + integration tests (fixture repo)
scripts/smoke.mjs           HTTP end-to-end smoke test
data/                       SQLite database (gitignored, created on first run)
```

## Environment variables

- `RAT_DB_PATH` — SQLite file location (default: `data/rat.db`)
- `RAT_URL` — base URL used by the smoke test (default: `http://localhost:3000`)
