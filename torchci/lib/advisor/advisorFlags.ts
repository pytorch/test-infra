// Deployment flags for the two Dr.CI advisor consumers.
//
// Separate from advisorConfig.ts because that module is pure data with no
// server-only behavior and is imported by React components; these read
// process.env, which a client caller would see as unset. Separate from the
// consumers themselves so that deciding whether to read verdicts at all costs
// no import of the modules that consume them -- advisorComment reaches the AWS
// SDK through its dispatch-state dependency.

import { isAdvisorEnabled } from "lib/advisor/advisorConfig";

// Render the inline "AI verdict:" line in the Dr.CI comment. Its own flag so it
// ships dark and can be enabled per deployment (Vercel env var), independently
// of the auto-dispatch flag. Display-only, so it doesn't also require
// VERCEL_ENV (unlike auto-dispatch, which fires real workflow_dispatches).
export function advisorCommentEnabled(owner: string, repo: string): boolean {
  return (
    process.env.DRCI_ADVISOR_COMMENT_ENABLED === "true" &&
    isAdvisorEnabled(owner, repo)
  );
}

// Move advisor-cleared failures out of the blocking set. Separate from the
// display flag above because this one decides whether a merge is allowed, not
// just what the comment says.
export function advisorSuppressionEnabled(
  owner: string,
  repo: string
): boolean {
  return (
    process.env.DRCI_ADVISOR_SUPPRESSION_ENABLED === "true" &&
    isAdvisorEnabled(owner, repo)
  );
}
