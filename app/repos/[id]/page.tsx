import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "../../../lib/db";
import { queryFileTotals, summarizeTotals } from "../../../lib/queries";

export const dynamic = "force-dynamic";

interface RepoRow {
  id: number;
  name: string;
  source_kind: string;
  source_ref: string;
  commit_count: number;
  created_at: string;
}

export default async function RepoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repoId = Number(id);
  if (!Number.isInteger(repoId) || repoId <= 0) notFound();

  const repo = getDb()
    .prepare(
      "SELECT id, name, source_kind, source_ref, commit_count, created_at FROM repos WHERE id = ?",
    )
    .get(repoId) as RepoRow | undefined;
  if (repo === undefined) notFound();

  const files = queryFileTotals(repoId);
  const totals = summarizeTotals(files);

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

      <div className="stats">
        <Stat label="Added lines" value={totals.added} />
        <Stat label="Removed lines" value={totals.removed} />
        <Stat label="Growth" value={totals.growth} />
        <Stat label="Churn" value={totals.churn} />
      </div>

      <div className="card">
        <h2>File metrics over the ingested commit set</h2>
        <p className="muted">
          l+ / l− / δ / λ summed over every non-merge commit reachable from {repo.source_ref}.
          Binary files are excluded; renames are attributed to the new path.
        </p>
        <table>
          <thead>
            <tr>
              <th>Path</th>
              <th className="num">Added</th>
              <th className="num">Removed</th>
              <th className="num">Growth</th>
              <th className="num">Churn</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr key={file.path}>
                <td>{file.path}</td>
                <td className="num">{file.added}</td>
                <td className="num">{file.removed}</td>
                <td className="num">{file.growth}</td>
                <td className="num">{file.churn}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
