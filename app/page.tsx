import Link from "next/link";
import UploadForm from "../components/UploadForm";
import { getDb } from "../lib/db";

export const dynamic = "force-dynamic";

interface RepoRow {
  id: number;
  name: string;
  commit_count: number;
  created_at: string;
}

export default function HomePage() {
  const repos = getDb()
    .prepare("SELECT id, name, commit_count, created_at FROM repos ORDER BY id DESC")
    .all() as RepoRow[];

  return (
    <>
      <h1>Repositories</h1>
      <UploadForm />
      {repos.length === 0 ? (
        <p className="muted">
          No repositories yet. Upload a .zip that includes the repository&apos;s .git directory,
          or paste a clone URL.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">Commits (non-merge)</th>
              <th>Ingested (UTC)</th>
            </tr>
          </thead>
          <tbody>
            {repos.map((repo) => (
              <tr key={repo.id}>
                <td>
                  <Link href={`/repos/${repo.id}`}>{repo.name}</Link>
                </td>
                <td className="num">{repo.commit_count}</td>
                <td className="muted">{repo.created_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
