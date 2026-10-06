import { NextResponse } from "next/server";
import { parseCommitSetFilter } from "../../../../../lib/commitSet";
import { getDb } from "../../../../../lib/db";
import {
  countMailmapMergedCommits,
  queryAuthorLeaderboard,
  queryCommitSetMetrics,
  queryObjectAuthorMetrics,
  queryObjectTopAuthors,
  resolveCommitShas,
  type ObjectTopAuthor,
} from "../../../../../lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The commit set H behind every returned metric, chosen via query parameters:
//   (none)                 → all of H-bar
//   ?mode=period&from=i&to=j → H_{i,j} = {i ≤ committer date < j}, unix
//                            seconds, i inclusive / j exclusive, either
//                            bound optional
//   ?mode=commits&commit=<sha>&commit=<sha>&shas=a,b → any subset of H-bar;
//                            an empty selection is the empty commit set
// Author metrics (the brief's 2.5) are always included:
//   ?object=<path> → per-author mods/churn/ownership of that file or directory
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const repoId = Number(id);
  const repo = Number.isInteger(repoId)
    ? getDb()
        .prepare(
          "SELECT id, name, source_kind, source_ref, commit_count, created_at FROM repos WHERE id = ?",
        )
        .get(repoId)
    : undefined;
  if (repo === undefined) {
    return NextResponse.json({ error: "Repository not found." }, { status: 404 });
  }

  const searchParams = new URL(request.url).searchParams;
  const filter = parseCommitSetFilter(searchParams);
  const { shas, unknown } = resolveCommitShas(repoId, filter.shaTokens);
  const active = {
    mode: filter.mode,
    fromTs: filter.fromTs,
    toTs: filter.toTs,
    shas,
  };
  const commitSet = queryCommitSetMetrics(repoId, active);

  // Author metrics: the leaderboard (root object) plus each object's top
  // author, with h[a] = the .mailmap-mapped identity stored at ingest.
  const authors = queryAuthorLeaderboard(repoId, active);
  // Directories first so a path that was both a file and a directory keeps
  // its file rows (the same precedence as queryObjectAuthorMetrics).
  const byTopAuthor = new Map<string, ObjectTopAuthor>();
  for (const row of queryObjectTopAuthors(repoId, active, "dir_deltas")) byTopAuthor.set(row.path, row);
  for (const row of queryObjectTopAuthors(repoId, active, "file_deltas")) byTopAuthor.set(row.path, row);
  const withTopAuthor = <T extends { path: string }>(
    rows: T[],
  ): Array<T & { topAuthor: ObjectTopAuthor | null }> =>
    rows.map((row) => ({ ...row, topAuthor: byTopAuthor.get(row.path) ?? null }));

  const objectPath = (searchParams.get("object") ?? "").trim();
  const objectAuthors = objectPath === "" ? null : queryObjectAuthorMetrics(repoId, active, objectPath);

  return NextResponse.json({
    repo,
    filter: {
      mode: filter.mode,
      fromTs: filter.fromTs ?? null,
      toTs: filter.toTs ?? null,
      shas,
      unknownShas: unknown,
    },
    commitSetSize: commitSet.size,
    totals: commitSet.repo,
    repoTotals: commitSet.repo,
    files: withTopAuthor(commitSet.files),
    directories: withTopAuthor(commitSet.directories),
    authorMetrics: {
      mailmapMergedCommits: countMailmapMergedCommits(repoId),
      authors,
      ...(objectAuthors === null ? {} : { object: objectAuthors }),
    },
  });
}
