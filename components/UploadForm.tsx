"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

export default function UploadForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const hasUrl = url.trim() !== "";
    if (file === null && !hasUrl) {
      setError("Choose a .zip file or enter a repository URL.");
      return;
    }
    if (file !== null && hasUrl) {
      setError("Provide either a .zip file or a repository URL, not both.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      if (file !== null) body.set("file", file);
      if (hasUrl) body.set("url", url.trim());
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
        Upload a .zip of a Git repository (it must contain the repository&apos;s .git directory),
        or paste a remote repository URL to deep-clone it. Provide one or the other.
      </p>
      <label htmlFor="repo-file">Repository zip</label>
      <input
        id="repo-file"
        type="file"
        accept=".zip,application/zip"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <label htmlFor="repo-url">&hellip;or clone URL</label>
      <input
        id="repo-url"
        type="text"
        placeholder="https://github.com/DaveGamble/cJSON.git"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
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
        {busy
          ? url.trim() !== ""
            ? "Cloning & ingesting…"
            : "Ingesting…"
          : url.trim() !== ""
            ? "Clone & ingest"
            : "Upload & ingest"}
      </button>
      {error !== null ? <p className="error">{error}</p> : null}
    </form>
  );
}
