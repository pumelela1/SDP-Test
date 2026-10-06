import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db";
import { ingestFromZip } from "../../../lib/git/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let uploadDir: string | null = null;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (file === null || typeof file === "string") {
      return NextResponse.json(
        { error: "Attach a .zip file of a Git repository." },
        { status: 400 },
      );
    }

    const uploadName =
      typeof (file as File).name === "string" ? (file as File).name : "repository.zip";
    const name =
      String(form.get("name") ?? "").trim() ||
      uploadName.replace(/\.zip$/i, "") ||
      "Unnamed repository";

    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "rat-upload-"));
    const zipPath = path.join(uploadDir, "upload.zip");
    fs.writeFileSync(zipPath, Buffer.from(await file.arrayBuffer()));

    const result = ingestFromZip(zipPath, { name });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  } finally {
    if (uploadDir !== null) {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  }
}

export async function GET() {
  const repos = getDb()
    .prepare("SELECT id, name, commit_count, created_at FROM repos ORDER BY id DESC")
    .all();
  return NextResponse.json({ repos });
}
