// Fetches one PR's GreenLight state, one row per commit GreenLight reviewed.
// Shared by the commit page's verdict section and the PR page's commit picker,
// which both need the same rows keyed different ways -- so they must issue one
// request between them, not one each.

import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import {
  greenlightRepoKey,
  isGreenlightRepo,
} from "lib/greenlight/greenlightConfig";
import { GreenlightPrStateRow } from "lib/greenlight/greenlightHudState";

/**
 * `greenlight_pr_state_history` rows for `prNumber`, or undefined while loading
 * or when there is nothing to ask for -- a repo outside GREENLIGHT_REPOS, or a
 * commit with no associated PR (`prNum` is null for a direct push).
 *
 * Immutable, matching the advisor and CRCR reads elsewhere in the HUD. A live
 * review does move: AI_REVIEW_DISPATCHED -> AI_REVIEW_STARTED -> a verdict, over
 * tens of minutes. SWR still revalidates on focus and on remount, which is when
 * someone watching a PR page actually looks, and polling a ~35-minute transition
 * on an interval would cost far more reads than it informs.
 */
export function useGreenlightPrHistory(
  repoOwner: string | undefined,
  repoName: string | undefined,
  prNumber: number | null | undefined
) {
  const enabled =
    repoOwner !== undefined &&
    repoName !== undefined &&
    isGreenlightRepo(repoOwner, repoName) &&
    prNumber != null &&
    prNumber > 0;

  return useClickHouseAPIImmutable<GreenlightPrStateRow>(
    "greenlight_pr_state_history",
    {
      // Empty strings rather than a conditional object: the hook must be called
      // unconditionally, and `enabled` already stops the request being made.
      repo: enabled ? greenlightRepoKey(repoOwner, repoName) : "",
      prNumber: enabled ? prNumber : 0,
    },
    enabled
  );
}
