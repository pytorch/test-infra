// Per-repo configuration for the AI CI Advisor.
//
// Single source of truth shared by:
//   - the manual "AI Analyze" dispatch endpoint (pull/dispatch-advisor.ts),
//   - the automatic Dr.CI dispatch loop (lib/advisor/advisorDispatch.ts),
//   - the frontend (FilteredJobList.tsx) to gate the manual button.
//
// It is pure data with no server-only imports, so it can be imported from both
// API routes and React components.

// If a PR has more than this many NEW failures, auto-dispatch bails for that PR
// entirely (dispatches nothing) -- a flood of new failures is almost always an
// outage rather than a PR problem, and we don't want to fan dozens of advisor
// runs out per PR. Used as the fallback when a repo doesn't set its own.
export const DEFAULT_MAX_NEW_FAILURES = 8;

export interface AdvisorRepoConfig {
  // The workflow_dispatch file (on the repo's default branch) that runs the
  // advisor analysis for this repo.
  workflowFile: string;
  // Auto-dispatch bails entirely if a PR has more than this many NEW failures
  // (outage guard). Falls back to DEFAULT_MAX_NEW_FAILURES when unset.
  maxNewFailures?: number;
}

// Repos with the AI advisor enabled, keyed by "owner/repo".
//
// Adding a repo here enables BOTH the manual button and -- when the
// DRCI_ADVISOR_AUTODISPATCH_ENABLED flag is on and VERCEL_ENV is production --
// automatic dispatch on Dr.CI new failures. Enabling a repo is a deliberate,
// reviewed action because every dispatch costs an LLM analysis.
export const ADVISOR_REPOS: Record<string, AdvisorRepoConfig> = {
  "pytorch/pytorch": {
    workflowFile: "claude-autorevert-advisor.yml",
    maxNewFailures: 8,
  },
};

export function getAdvisorRepoConfig(
  owner: string,
  repo: string
): AdvisorRepoConfig | undefined {
  return ADVISOR_REPOS[`${owner}/${repo}`];
}

export function isAdvisorEnabled(owner: string, repo: string): boolean {
  return getAdvisorRepoConfig(owner, repo) !== undefined;
}

// The NEW-failure count above which auto-dispatch bails for a PR, per repo.
export function getMaxNewFailures(owner: string, repo: string): number {
  return (
    getAdvisorRepoConfig(owner, repo)?.maxNewFailures ??
    DEFAULT_MAX_NEW_FAILURES
  );
}
