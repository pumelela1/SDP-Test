import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db";
import { queryFileTotals, summarizeTotals } from "../../../../../lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
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

  const files = queryFileTotals(repoId);
  return NextResponse.json({ repo, totals: summarizeTotals(files), files });
}
