// One PR's GreenLight state, a row per reviewed commit. Shared by the verdict
// panel and the PR page's commit picker so they cost one request, not two.

import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import {
  greenlightRepoKey,
  isGreenlightRepo,
} from "lib/greenlight/greenlightConfig";
import { GreenlightPrStateRow } from "lib/greenlight/greenlightHudState";

/**
 * Undefined while loading, and when there is nothing to ask for: a repo outside
 * GREENLIGHT_REPOS, or a commit with no PR.
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
      // The hook is called unconditionally; `enabled` stops the request.
      repo: enabled ? greenlightRepoKey(repoOwner, repoName) : "",
      prNumber: enabled ? prNumber : 0,
    },
    enabled
  );
}
