import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { getDb } from "../../../lib/db";
import { ingestFromUrl, ingestFromZip, repoNameFromUrl } from "../../../lib/git/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let uploadDir: string | null = null;
  try {
    const form = await request.formData();
    const file = form.get("file");
    const urlValue = form.get("url");
    const url = typeof urlValue === "string" ? urlValue.trim() : "";
    const hasFile = file !== null && typeof file !== "string";

    if (!hasFile && url === "") {
      return NextResponse.json(
        { error: "Attach a .zip file of a Git repository, or provide a remote repository URL." },
        { status: 400 },
      );
    }
    if (hasFile && url !== "") {
      return NextResponse.json(
        { error: "Provide either a .zip file or a repository URL, not both." },
        { status: 400 },
      );
    }

    const uploadName =
      hasFile && typeof (file as File).name === "string" ? (file as File).name : "repository.zip";
    const name =
      String(form.get("name") ?? "").trim() ||
      (url !== "" ? repoNameFromUrl(url) : uploadName.replace(/\.zip$/i, "")) ||
      "Unnamed repository";

    if (url !== "") {
      return NextResponse.json(ingestFromUrl(url, { name }), { status: 201 });
    }

    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "rat-upload-"));
    const zipPath = path.join(uploadDir, "upload.zip");
    fs.writeFileSync(zipPath, Buffer.from(await (file as File).arrayBuffer()));

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
