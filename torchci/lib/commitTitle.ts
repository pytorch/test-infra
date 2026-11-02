// How a commit title is read, shared by the commit summary
// (lib/api/tests/commit/summary/summary.ts), which names the pull request a
// branch commit's title ends in, and the commit page's headline
// (lib/tests/commit.ts), which takes that suffix off, so the two never read a
// title differently. Free of imports, so either side can take it without the
// other's dependencies.

// The first line of a commit message, trimmed.
export function titleFirstLine(message: string): string {
  return message.split("\n")[0].trim();
}

// The pull request a merged commit's title ends in, "(#202376)".
const TITLE_PULL_REQUEST = /\s*\(#(\d+)\)\s*$/;

// The pull request a title's first line ends in, with the line before it;
// null when it ends in none.
export function titleSuffix(
  firstLine: string
): { pullRequest: number; text: string } | null {
  const match = TITLE_PULL_REQUEST.exec(firstLine);
  if (match === null) return null;
  return {
    pullRequest: Number(match[1]),
    text: firstLine.slice(0, match.index).trimEnd(),
  };
}
