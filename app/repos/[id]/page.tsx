import Link from "next/link";
import { notFound } from "next/navigation";
import {
  describeCommitSetFilter,
  formatTimestampInput,
  formatTimestampUtc,
  parseCommitSetFilter,
  type ResolvedCommitSetFilter,
} from "../../../lib/commitSet";
import { getDb } from "../../../lib/db";
import {
  countMailmapMergedCommits,
  queryAuthorLeaderboard,
  queryCommitPickerRows,
  queryCommitSetMetrics,
  queryObjectAuthorMetrics,
  queryObjectTopAuthors,
  resolveCommitShas,
  type ObjectTopAuthor,
} from "../../../lib/queries";
import { ROOT_DIR } from "../../../lib/rollup";

export const dynamic = "force-dynamic";

interface RepoRow {
  id: number;
  name: string;
  source_kind: string;
  source_ref: string;
  commit_count: number;
  created_at: string;
}

type SearchParams = Record<string, string | string[] | undefined>;

export default async function RepoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const repoId = Number(id);
  if (!Number.isInteger(repoId) || repoId <= 0) notFound();

  const repo = getDb()
    .prepare(
      "SELECT id, name, source_kind, source_ref, commit_count, created_at FROM repos WHERE id = ?",
    )
    .get(repoId) as RepoRow | undefined;
  if (repo === undefined) notFound();

  // The commit set H behind every metric on the page: all of H-bar, a period
  // of the committer date, or a manually picked list of commits.
  const query = toUrlSearchParams(await searchParams);
  const filter = parseCommitSetFilter(query);
  const { shas, unknown } = resolveCommitShas(repoId, filter.shaTokens);
  const active: ResolvedCommitSetFilter = {
    mode: filter.mode,
    fromTs: filter.fromTs,
    toTs: filter.toTs,
    shas,
  };
  const metrics = queryCommitSetMetrics(repoId, active);
  const pickerRows = queryCommitPickerRows(repoId);
  const selected = new Set(shas);

  // Author metrics (section 2.5): every author is the .mailmap-mapped identity
  // stored at ingest, so a merged author already owns all their commits.
  const authors = queryAuthorLeaderboard(repoId, active);
  const mailmapMerged = countMailmapMergedCommits(repoId);
  const byTopAuthor = new Map<string, ObjectTopAuthor>();
  for (const row of queryObjectTopAuthors(repoId, active, "dir_deltas")) byTopAuthor.set(row.path, row);
  for (const row of queryObjectTopAuthors(repoId, active, "file_deltas")) byTopAuthor.set(row.path, row);

  // ?object=<path> drills into one file or directory's per-author metrics.
  const objectPath = (query.get("object") ?? "").trim();
  const objectMetrics =
    objectPath === "" ? null : queryObjectAuthorMetrics(repoId, active, objectPath);

  return (
    <>
      <p>
        <Link href="/">← All repositories</Link>
      </p>
      <h1>{repo.name}</h1>
      <p className="muted">
        {repo.commit_count} non-merge commits reachable from {repo.source_ref} · source:{" "}
        {repo.source_kind} · ingested {repo.created_at} UTC
      </p>

      <form method="get" action={`/repos/${repo.id}`} className="card filter-form">
        <h2>Commit set</h2>
        <p className="muted">
          Every metric on this page is a commit-set sum over H — the commits chosen here. The
          committer date drives period filters; times are UTC.
        </p>
        <label className="choice">
          <input type="radio" name="mode" value="all" defaultChecked={filter.mode === "all"} />
          All commits — H̄, every non-merge commit reachable from {repo.source_ref}
        </label>
        <label className="choice">
          <input
            type="radio"
            name="mode"
            value="period"
            defaultChecked={filter.mode === "period"}
          />
          <span>Period of the committer date (UTC):</span>
          <input
            type="datetime-local"
            name="from"
            step={1}
            defaultValue={filter.fromTs !== undefined ? formatTimestampInput(filter.fromTs) : ""}
            aria-label="i — inclusive period start (UTC)"
          />
          <span>≤ t</span>
          <input
            type="datetime-local"
            name="to"
            step={1}
            defaultValue={filter.toTs !== undefined ? formatTimestampInput(filter.toTs) : ""}
            aria-label="j — exclusive period end (UTC)"
          />
          <span>&lt; t</span>
          <span className="muted">i inclusive, j exclusive; either bound may stay empty</span>
        </label>
        <label className="choice">
          <input
            type="radio"
            name="mode"
            value="commits"
            defaultChecked={filter.mode === "commits"}
          />
          Manual commit list — any subset of H̄ (an empty selection is the empty set)
        </label>
        <div className="picker">
          {pickerRows.map((commit) => (
            <label key={commit.sha} className={selected.has(commit.sha) ? "picked" : undefined}>
              <input
                type="checkbox"
                name="commit"
                value={commit.sha}
                defaultChecked={selected.has(commit.sha)}
              />
              <code>{commit.sha.slice(0, 10)}</code>
              <span>{commit.author_name}</span>
              <span className="muted">{formatTimestampUtc(commit.committer_ts)}</span>
            </label>
          ))}
        </div>
        <label>
          Or paste commit SHAs — comma or whitespace separated, full or unique prefixes
          <input
            type="text"
            name="shas"
            defaultValue={(query.get("shas") ?? "").trim()}
            placeholder="e.g. 1a2b3c4d"
          />
        </label>
        {unknown.length > 0 && (
          <p className="error">Ignored — no single commit matches: {unknown.join(", ")}</p>
        )}
        <p className="muted">
          Computing over: {describeCommitSetFilter(active, metrics.size)}
        </p>
        <button type="submit">Apply commit set</button>{" "}
        <Link href={`/repos/${repo.id}`} className="muted">
          Reset to H̄
        </Link>
      </form>

      <div className="stats">
        <Stat label="Commits |H|" value={metrics.size} />
        <Stat label="Added lines" value={metrics.repo.added} />
        <Stat label="Removed lines" value={metrics.repo.removed} />
        <Stat label="Growth" value={metrics.repo.growth} />
        <Stat label="Churn" value={metrics.repo.churn} />
        <Stat label="Modifications n" value={metrics.repo.modifications} />
        <Stat label="Mod frequency η" value={formatRatio(metrics.repo.modFrequency)} />
        <Stat label="Churn rate ρ" value={formatRatio(metrics.repo.churnRate)} />
      </div>

      <div className="card">
        <h2>Author metrics over the commit set</h2>
        <p className="muted">
          {mailmapMerged > 0
            ? `Author identities are merged with the repository's .mailmap — ${mailmapMerged} of ${repo.commit_count} commits were re-attributed to their canonical author.`
            : "No .mailmap merges applied (no .mailmap in the repository, or none of its rules matched) — each commit keeps its raw author identity."}
        </p>
        <p className="muted">
          Author churn λ is the root-object churn (all files roll up to the root); ownership
          ω = λ<sub>a</sub> / λ<sub>root</sub>, 0 when the churn is 0. Click a path in the tables
          below for its per-author breakdown.
        </p>
        <table>
          <thead>
            <tr>
              <th>Author</th>
              <th className="num">Commits</th>
              <th className="num">Added</th>
              <th className="num">Removed</th>
              <th className="num">Growth</th>
              <th className="num">Churn λ</th>
              <th className="num">Ownership ω</th>
            </tr>
          </thead>
          <tbody>
            {authors.map((author) => (
              <tr key={`${author.name} <${author.email}>`}>
                <td>
                  {author.name} <span className="muted">&lt;{author.email}&gt;</span>
                </td>
                <td className="num">{author.commits}</td>
                <td className="num">{author.added}</td>
                <td className="num">{author.removed}</td>
                <td className="num">{author.growth}</td>
                <td className="num">{author.churn}</td>
                <td className="num">{formatOwnership(author.ownership)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {objectPath !== "" && objectMetrics === null && (
        <p className="error">
          No measured changes on &quot;{objectPath}&quot; in this commit set (binary files and
          pure renames leave no author rows).
        </p>
      )}

      {objectMetrics !== null && (
        <div className="card">
          <h2>
            Author metrics — {objectMetrics.path === ROOT_DIR ? "(repo root)" : objectMetrics.path}{" "}
            <span className="muted">({objectMetrics.kind})</span>
          </h2>
          <p className="muted">
            Per-author modifications n (commits with λ(h, o) &gt; 0), churn λ<sub>a</sub> and
            ownership ω = λ<sub>a</sub> / λ<sub>o</sub> on this one object over the commit set
            (total churn {objectMetrics.churn}).
          </p>
          <table>
            <thead>
              <tr>
                <th>Author</th>
                <th className="num">Mods n</th>
                <th className="num">Added</th>
                <th className="num">Removed</th>
                <th className="num">Churn λ</th>
                <th className="num">Ownership ω</th>
              </tr>
            </thead>
            <tbody>
              {objectMetrics.authors.map((author) => (
                <tr key={`${author.name} <${author.email}>`}>
                  <td>
                    {author.name} <span className="muted">&lt;{author.email}&gt;</span>
                  </td>
                  <td className="num">{author.modifications}</td>
                  <td className="num">{author.added}</td>
                  <td className="num">{author.removed}</td>
                  <td className="num">{author.churn}</td>
                  <td className="num">{formatOwnership(author.ownership)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Directory metrics over the commit set</h2>
        <p className="muted">
          Recursive rollup materialized at ingest: l+/l−/δ/λ summed over h ∈ H, modifications n
          = commits with λ &gt; 0, η = n/|H|, ρ = λ/|H| (0 when |H| = 0). The root row is the
          repository metric.
        </p>
        <table>
          <thead>
            <tr>
              <th>Directory</th>
              <th className="num">Added</th>
              <th className="num">Removed</th>
              <th className="num">Growth</th>
              <th className="num">Churn</th>
              <th className="num">Mods n</th>
              <th className="num">η</th>
              <th className="num">ρ</th>
              <th>Top author</th>
              <th className="num">ω</th>
            </tr>
          </thead>
          <tbody>
            {metrics.directories.map((dir) => (
              <tr key={dir.path}>
                <td>
                  <Link href={objectHref(query, repo.id, dir.path)}>
                    {dir.path === ROOT_DIR ? "(repo root)" : dir.path}
                  </Link>
                </td>
                <td className="num">{dir.added}</td>
                <td className="num">{dir.removed}</td>
                <td className="num">{dir.growth}</td>
                <td className="num">{dir.churn}</td>
                <td className="num">{dir.modifications}</td>
                <td className="num">{formatRatio(dir.modFrequency)}</td>
                <td className="num">{formatRatio(dir.churnRate)}</td>
                <TopAuthorCells topAuthor={byTopAuthor.get(dir.path)} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>File metrics over the commit set</h2>
        <p className="muted">
          l+ / l− / δ / λ summed over h ∈ H. Binary files are excluded; renames are attributed
          to the new path; a pure rename (+0/−0) is never a modification.
        </p>
        <table>
          <thead>
            <tr>
              <th>Path</th>
              <th className="num">Added</th>
              <th className="num">Removed</th>
              <th className="num">Growth</th>
              <th className="num">Churn</th>
              <th className="num">Mods n</th>
              <th className="num">η</th>
              <th className="num">ρ</th>
              <th>Top author</th>
              <th className="num">ω</th>
            </tr>
          </thead>
          <tbody>
            {metrics.files.map((file) => (
              <tr key={file.path}>
                <td>
                  <Link href={objectHref(query, repo.id, file.path)}>{file.path}</Link>
                </td>
                <td className="num">{file.added}</td>
                <td className="num">{file.removed}</td>
                <td className="num">{file.growth}</td>
                <td className="num">{file.churn}</td>
                <td className="num">{file.modifications}</td>
                <td className="num">{formatRatio(file.modFrequency)}</td>
                <td className="num">{formatRatio(file.churnRate)}</td>
                <TopAuthorCells topAuthor={byTopAuthor.get(file.path)} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Link to one object's per-author metrics, keeping the current commit-set filter. */
function objectHref(query: URLSearchParams, repoId: number, objectPath: string): string {
  const params = new URLSearchParams(query.toString());
  params.set("object", objectPath);
  return `/repos/${repoId}?${params.toString()}`;
}

/** The top-author cells of a metrics row; "—" when the object has no author rows. */
function TopAuthorCells({ topAuthor }: { topAuthor?: ObjectTopAuthor }) {
  if (topAuthor === undefined) {
    return (
      <>
        <td className="muted">—</td>
        <td className="num muted">—</td>
      </>
    );
  }
  return (
    <>
      <td>
        {topAuthor.name} <span className="muted">&lt;{topAuthor.email}&gt;</span>
      </td>
      <td className="num">{formatOwnership(topAuthor.ownership)}</td>
    </>
  );
}

/** Next hands searchParams over as a record; the parser reads URLSearchParams. */
function toUrlSearchParams(record: SearchParams): URLSearchParams {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) result.append(key, item);
  }
  return result;
}

/** η and ρ are ratios; three decimals keep the columns comparable. */
function formatRatio(value: number): string {
  return value.toFixed(3);
}

/** Ownership ω ∈ [0, 1] — shown as a percentage with one decimal. */
function formatOwnership(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
