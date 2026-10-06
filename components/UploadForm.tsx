"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

export default function UploadForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (file === null) {
      setError("Choose a .zip file first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("file", file);
      if (name.trim() !== "") body.set("name", name.trim());
      const response = await fetch("/api/repos", { method: "POST", body });
      const data = (await response.json().catch(() => ({}))) as {
        repoId?: number;
        error?: string;
      };
      if (!response.ok || typeof data.repoId !== "number") {
        throw new Error(data.error ?? `Upload failed (HTTP ${response.status}).`);
      }
      router.push(`/repos/${data.repoId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit}>
      <h2>Add a repository</h2>
      <p className="muted">
        Upload a .zip of a Git repository. The zip must contain the repository&apos;s .git
        directory.
      </p>
      <label htmlFor="repo-file">Repository zip</label>
      <input
        id="repo-file"
        type="file"
        accept=".zip,application/zip"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <label htmlFor="repo-name">Display name (optional)</label>
      <input
        id="repo-name"
        type="text"
        placeholder="e.g. cJSON"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" disabled={busy}>
        {busy ? "Ingesting…" : "Upload & ingest"}
      </button>
      {error !== null ? <p className="error">{error}</p> : null}
    </form>
  );
}
