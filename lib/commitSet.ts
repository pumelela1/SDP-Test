/**
 * Commit-set filters: how a commit set H is chosen out of H-bar (the ingested
 * non-merge commits reachable from the ref). The brief allows two forms —
 * a period of the committer date, or a manually selected list of commits:
 *
 * - H_t   = {h ∈ H̄ | t ≤ h[committer-date]}                  (from-only period)
 * - H_i,j = {h ∈ H̄ | i ≤ h[committer-date] < j}              (period, j exclusive)
 * - manual list = any subset of H̄ (an empty selection is the EMPTY set,
 *   never "everything")
 *
 * The committer date drives all time filters and is handled as raw unix
 * seconds throughout.
 */

export type CommitSetMode = "all" | "period" | "commits";

/** A commit-set filter as it arrives from the URL / GET form. */
export interface CommitSetFilter {
  mode: CommitSetMode;
  /** i of H_{i,j}: inclusive lower bound on the committer date (unix seconds). */
  fromTs?: number;
  /** j of H_{i,j}: exclusive upper bound on the committer date (unix seconds). */
  toTs?: number;
  /** Manual selection tokens: picker checkbox values + pasted SHAs, raw. */
  shaTokens: string[];
}

/** A commit-set filter whose manual tokens are resolved to commits of the repo. */
export interface ResolvedCommitSetFilter {
  mode: CommitSetMode;
  fromTs?: number;
  toTs?: number;
  shas: string[];
}

/** Reads the filter out of a URL's query parameters (GET-form friendly). */
export function parseCommitSetFilter(searchParams: URLSearchParams): CommitSetFilter {
  const mode = searchParams.get("mode");
  return {
    mode: mode === "period" || mode === "commits" ? mode : "all",
    fromTs: parseTimestampInput(searchParams.get("from")),
    toTs: parseTimestampInput(searchParams.get("to")),
    shaTokens: splitShaTokens(
      searchParams.getAll("commit").join(",") + "," + (searchParams.get("shas") ?? ""),
    ),
  };
}

/** Splits pasted SHA text on whitespace, commas and semicolons. */
export function splitShaTokens(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter((token) => token !== "");
}

/**
 * Parses a period bound: unix seconds ("1700003600") or a datetime-local
 * value ("2024-11-14T22:13[:ss]"), which is read as UTC — dates are unix
 * timestamps, so a naive local reading would make filters machine-dependent.
 * "" and unparsable values mean "no bound".
 */
export function parseTimestampInput(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = raw.trim();
  if (value === "") return undefined;
  if (/^-?\d+$/.test(value)) {
    const seconds = Number.parseInt(value, 10);
    return Number.isFinite(seconds) ? seconds : undefined;
  }
  const hasZone = /(?:Z|z|[+-]\d{2}:?\d{2})$/.test(value);
  const parsed = Date.parse(hasZone ? value : `${value}Z`);
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}

/** Formats unix seconds as a datetime-local input value in UTC (with seconds). */
export function formatTimestampInput(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 19);
}

/** Formats unix seconds for display, e.g. "2024-11-14 22:13:20 UTC". */
export function formatTimestampUtc(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** One-line description of the commit set the metrics are computed over. */
export function describeCommitSetFilter(filter: ResolvedCommitSetFilter, size: number): string {
  if (filter.mode === "period") {
    const from = filter.fromTs !== undefined ? formatTimestampUtc(filter.fromTs) : "−∞";
    const to = filter.toTs !== undefined ? formatTimestampUtc(filter.toTs) : "the present";
    return `period ${from} ≤ committer date < ${to} — |H| = ${size}`;
  }
  if (filter.mode === "commits") return `manual selection — |H| = ${size}`;
  return `all of H̄ — |H| = ${size}`;
}
