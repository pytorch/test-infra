/**
 * A repo allowlist is a comma-separated list of `owner/repo` or `owner/*`
 * entries. Matching is case-insensitive, and an empty or unset value parses to
 * an empty set, which enables nothing.
 */
export function parseRepoAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
  );
}

export function isRepoEnabled(
  allowlist: Set<string>,
  owner: string,
  repo: string
): boolean {
  return (
    allowlist.has(`${owner}/${repo}`.toLowerCase()) ||
    allowlist.has(`${owner.toLowerCase()}/*`)
  );
}
