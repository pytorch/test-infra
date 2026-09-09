// Whether a verdict still speaks for the PR's head, and how the comment says so.
// The sibling of greenlightStaleness.ts: that one ages an in-flight review out by
// wall clock, this one retires a finished one by commit. Both answer "is this row
// still about the PR as it stands now", and neither can be derived from the other
// -- a verdict minutes old is stale the moment a push lands, and one from last
// month still holds if nothing was pushed since.

import { shortSha } from "lib/greenlight/greenlightInlineCode";

// Whether the verdict was reached on something other than the PR's current head.
// A missing sha on either side means the comparison cannot be made, which is not
// evidence of a mismatch.
export function isOutdatedVerdict(
  reviewedSha: string,
  currentSha: string
): boolean {
  const reviewed = (reviewedSha || "").trim().toLowerCase();
  const current = (currentSha || "").trim().toLowerCase();
  return reviewed !== "" && current !== "" && reviewed !== current;
}

export function reviewedCommitLines(
  headSha: string,
  currentHeadSha: string
): string[] {
  const sha = (headSha || "").trim();
  if (!sha) {
    return [];
  }
  const line = `Reviewed commit: ${shortSha(sha)}`;
  if (!isOutdatedVerdict(sha, currentHeadSha)) {
    return [line];
  }
  return [`${line} (NOT the current head ${shortSha(currentHeadSha)})`];
}
