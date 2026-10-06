export interface ParsedFileDelta {
  path: string;
  added: number;
  removed: number;
}

export interface ParsedCommit {
  sha: string;
  parentSha: string | null;
  committerTs: number;
  authorName: string;
  authorEmail: string;
  files: ParsedFileDelta[];
  binaryFileCount: number;
}

const COMMIT_MARK = "\x01";
const FIELD_SEP = "\x02";

/**
 * Parses the output of:
 *   git log --no-merges --find-renames=50% --numstat -z --format=%x01%H%x02%P%x02%ct%x02%an%x02%ae
 *
 * In `-z` mode git emits NUL-separated records with *raw* paths — no C-style
 * quoting and no brace compression — and renamed entries carry the full old
 * and new paths explicitly ("a\tb\t\0old\0new\0"). Parsing that stream (rather
 * than the quoted/brace-compressed text display) is what makes the rename
 * attribution exact for every possible filename.
 *
 * Hard rules applied here:
 * - binary files are not measured (git marks them with "-" coordinates, we
 *   drop those rows, renamed binaries included)
 * - renames are attributed to the new path (the entry's second path)
 * - the initial commit has no parent (h[p] = empty commit); git already diffs
 *   it against the empty tree, so its lines count as added
 */
export function parseGitLog(text: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  let current: ParsedCommit | null = null;
  // Rename entries continue after their "added\tremoved\t" prefix with two
  // more NUL-separated tokens (old path, then new path); 0 = not in one.
  let renameStage: 0 | 1 | 2 = 0;
  let renameAddedRaw = "";
  let renameRemovedRaw = "";

  const record = (addedRaw: string, removedRaw: string, path: string) => {
    if (current === null) return;
    if (addedRaw === "-" || removedRaw === "-") {
      current.binaryFileCount += 1;
      return;
    }
    const added = Number.parseInt(addedRaw, 10);
    const removed = Number.parseInt(removedRaw, 10);
    if (Number.isNaN(added) || Number.isNaN(removed)) return;
    current.files.push({ path, added, removed });
  };

  for (const raw of text.split("\0")) {
    // The old/new paths of a rename arrive positionally and must never be
    // touched — a filename may itself start with a newline or contain tabs.
    if (current !== null && renameStage === 1) {
      renameStage = 2; // old path: metrics are attributed to the new path only
      continue;
    }
    if (current !== null && renameStage === 2) {
      record(renameAddedRaw, renameRemovedRaw, raw);
      renameStage = 0;
      continue;
    }

    // git writes the commit header, then NUL, then a newline before the first
    // numstat entry; strip that single newline so the marker is at position 0.
    const line = raw.startsWith("\n") ? raw.slice(1) : raw;

    if (line.startsWith(COMMIT_MARK)) {
      const [sha, parents, committerTs, authorName, authorEmail] = line
        .slice(1)
        .split(FIELD_SEP);
      current = {
        sha,
        parentSha: parents ? parents.split(" ")[0] : null,
        committerTs: Number.parseInt(committerTs, 10),
        authorName,
        authorEmail,
        files: [],
        binaryFileCount: 0,
      };
      renameStage = 0;
      commits.push(current);
      continue;
    }

    // Defensive: a numstat row before any commit header cannot be attributed.
    if (current === null) continue;

    const parts = line.split("\t");
    if (parts.length >= 3 && parts[2] === "") {
      // Rename prefix: the old and new paths follow as separate NUL fields
      // ("-" coordinates mark a renamed binary, handled by record()).
      renameAddedRaw = parts[0];
      renameRemovedRaw = parts[1];
      renameStage = 1;
      continue;
    }
    if (parts.length < 3) continue; // trailing empty token and malformed rows
    record(parts[0], parts[1], parts.slice(2).join("\t"));
  }

  return commits;
}

/**
 * Rename detection runs at a 50% threshold, so git prints renamed objects as
 * "old => new" (sometimes brace-compressed). Metrics are attributed to the new path.
 */
export function renameTargetPath(raw: string): string {
  const arrow = " => ";
  const arrowAt = raw.indexOf(arrow);
  if (arrowAt === -1) return raw;

  const openBrace = raw.lastIndexOf("{", arrowAt);
  if (openBrace !== -1) {
    const closeBrace = raw.indexOf("}", arrowAt);
    if (closeBrace !== -1) {
      const newName = raw.slice(arrowAt + arrow.length, closeBrace);
      return raw.slice(0, openBrace) + newName + raw.slice(closeBrace + 1);
    }
  }
  return raw.slice(arrowAt + arrow.length);
}

/**
 * When a renamed path needs C-quoting, git cannot brace-compress the display;
 * it prints both paths quoted and escaped: `"old" => "new"`. Returns the
 * unescaped new path, or null when raw is not in that form.
 */
export function quotedRenameNewPath(raw: string): string | null {
  if (!raw.startsWith('"')) return null;

  // Find the closing quote of the old path (skipping \" escapes).
  let end = 1;
  while (end < raw.length && raw[end] !== '"') {
    if (raw[end] === "\\") end += 1;
    end += 1;
  }
  if (raw[end] !== '"' || raw.slice(end + 1, end + 5) !== " => ") return null;

  const newStart = end + 5; // first char of the quoted new path
  if (raw[newStart] !== '"' || !raw.endsWith('"') || newStart >= raw.length - 1) {
    return null;
  }
  return decodeQuotedBody(raw.slice(newStart + 1, -1));
}

/**
 * Resolves a text-mode numstat path field to the new path of a rename,
 * covering both git display forms: the quoted `"old" => "new"` pair and the
 * plain (brace-compressed) `pfx{a => b}sfx` row.
 */
export function resolveNumstatPath(raw: string): string {
  const quoted = quotedRenameNewPath(raw);
  if (quoted !== null) return quoted;
  return renameTargetPath(unquoteGitPath(raw));
}

/** git quotes paths containing control characters or quotes; undo the C-style escaping. */
export function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path;
  return decodeQuotedBody(path.slice(1, -1));
}

/** Decodes the body of a git C-quoted path (escapes such as \303 are raw BYTES). */
function decodeQuotedBody(inner: string): string {
  // Escapes such as "\303\251" are raw BYTES (UTF-8), so assemble bytes and decode.
  const bytes: number[] = [];
  const pushString = (value: string) => {
    for (const byte of Buffer.from(value, "utf8")) bytes.push(byte);
  };

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch !== "\\") {
      pushString(ch);
      continue;
    }
    const next = inner[i + 1];
    if (next >= "0" && next <= "7") {
      bytes.push(Number.parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
      continue;
    }
    i += 1;
    switch (next) {
      case "n":
        bytes.push(0x0a);
        break;
      case "t":
        bytes.push(0x09);
        break;
      case "r":
        bytes.push(0x0d);
        break;
      case '"':
        bytes.push(0x22);
        break;
      case "\\":
        bytes.push(0x5c);
        break;
      default:
        pushString(next);
        break;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
