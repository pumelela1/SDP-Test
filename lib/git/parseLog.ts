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
 *   git log --no-merges --find-renames=50% --numstat --format=%x01%H%x02%P%x02%ct%x02%an%x02%ae
 *
 * Hard rules applied here:
 * - binary files are not measured (git marks them with "-" coordinates, we drop those rows)
 * - renames ("old => new" display) are attributed to the new path
 * - the initial commit has no parent (h[p] = empty commit); git already diffs it against
 *   the empty tree, so its lines count as added
 */
export function parseGitLog(text: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  let current: ParsedCommit | null = null;

  for (const line of text.split("\n")) {
    if (line === "") continue;

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
      commits.push(current);
      continue;
    }

    // Defensive: a numstat row before any commit header cannot be attributed.
    if (current === null) continue;

    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const addedRaw = parts[0];
    const removedRaw = parts[1];
    const rawPath = parts.slice(2).join("\t");

    if (addedRaw === "-" || removedRaw === "-") {
      current.binaryFileCount += 1;
      continue;
    }

    const added = Number.parseInt(addedRaw, 10);
    const removed = Number.parseInt(removedRaw, 10);
    if (Number.isNaN(added) || Number.isNaN(removed)) continue;

    current.files.push({
      path: renameTargetPath(unquoteGitPath(rawPath)),
      added,
      removed,
    });
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

/** git quotes paths containing control characters or quotes; undo the C-style escaping. */
export function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path;

  const inner = path.slice(1, -1);
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
