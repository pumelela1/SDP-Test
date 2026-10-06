import { NextResponse } from "next/server";
import { parseCommitSetFilter } from "../../../../../lib/commitSet";
import { getDb } from "../../../../../lib/db";
import { queryCommitSetMetrics, resolveCommitShas } from "../../../../../lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The commit set H behind every returned metric, chosen via query parameters:
//   (none)                 → all of H-bar
//   ?mode=period&from=i&to=j → H_{i,j} = {i ≤ committer date < j}, unix
//                            seconds, i inclusive / j exclusive, either
//                            bound optional
//   ?mode=commits&commit=<sha>&commit=<sha>&shas=a,b → any subset of H-bar;
//                            an empty selection is the empty commit set
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

  const filter = parseCommitSetFilter(new URL(request.url).searchParams);
  const { shas, unknown } = resolveCommitShas(repoId, filter.shaTokens);
  const commitSet = queryCommitSetMetrics(repoId, {
    mode: filter.mode,
    fromTs: filter.fromTs,
    toTs: filter.toTs,
    shas,
  });

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
    files: commitSet.files,
    directories: commitSet.directories,
  });
}
