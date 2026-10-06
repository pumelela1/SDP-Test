import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

let db: Database.Database | null = null;

export function dbFilePath(): string {
  return process.env.RAT_DB_PATH ?? path.join(process.cwd(), "data", "rat.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  source_kind  TEXT NOT NULL,
  source_ref   TEXT NOT NULL DEFAULT 'HEAD',
  commit_count INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  sha           TEXT NOT NULL,
  parent_sha    TEXT,
  author_name   TEXT NOT NULL,
  author_email  TEXT NOT NULL,
  committer_ts  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commits_repo_sha ON commits(repo_id, sha);
CREATE INDEX IF NOT EXISTS idx_commits_repo_ts ON commits(repo_id, committer_ts);

CREATE TABLE IF NOT EXISTS file_deltas (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  commit_id  INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  added      INTEGER NOT NULL,
  removed    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_deltas_repo_path ON file_deltas(repo_id, path);
CREATE INDEX IF NOT EXISTS idx_file_deltas_commit ON file_deltas(commit_id);

CREATE TABLE IF NOT EXISTS dir_deltas (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  commit_id  INTEGER NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  added      INTEGER NOT NULL,
  removed    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dir_deltas_repo_path ON dir_deltas(repo_id, path);
CREATE INDEX IF NOT EXISTS idx_dir_deltas_commit ON dir_deltas(commit_id);
`;

export function getDb(): Database.Database {
  if (db !== null) return db;
  const file = dbFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
