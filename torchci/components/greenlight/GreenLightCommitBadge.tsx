// The GreenLight glyph shown beside a commit or PR title. Same row and same
// fetch as GreenLightSection below it -- SWR dedupes the identical key, so the
// two mount one request between them -- and it exists as its own component only
// because a page title is not somewhere a whole panel can go.

import GreenLightIcon from "components/greenlight/GreenLightIcon";
import { selectStateForSha } from "lib/greenlight/greenlightHudState";
import { useGreenlightPrHistory } from "lib/greenlight/useGreenlightPrHistory";

const SHORT_SHA_LENGTH = 7;

export default function GreenLightCommitBadge({
  repoOwner,
  repoName,
  prNumber,
  sha,
  size = 16,
}: {
  repoOwner: string;
  repoName: string;
  prNumber: number | null | undefined;
  /**
   * The commit to answer about. Omit it to ask about the PR instead, which is
   * what a PR title wants: no sha matches, so the selection falls through to the
   * PR's authoritative verdict and the tooltip names the commit it was reached
   * on.
   */
  sha?: string;
  size?: number;
}) {
  const { data: rows } = useGreenlightPrHistory(repoOwner, repoName, prNumber);
  const selected = selectStateForSha(rows, sha);
  if (selected === undefined) {
    return null;
  }

  const { state, isForThisSha } = selected;
  return (
    <GreenLightIcon
      status={state.status}
      size={size}
      // Named on a landed commit because it is always a different sha there:
      // pytorch rebases on merge, so the trunk commit is never the PR head
      // GreenLight reviewed. An unqualified glyph would claim otherwise.
      titleSuffix={
        isForThisSha
          ? undefined
          : `reviewed on ${state.head_sha
              .trim()
              .toLowerCase()
              .slice(0, SHORT_SHA_LENGTH)}`
      }
    />
  );
}
