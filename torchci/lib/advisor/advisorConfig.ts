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
//
// Exception: PRs carrying a label in OUTAGE_GUARD_BYPASS_LABELS are EXPECTED to
// fail broadly (e.g. ci-no-td runs the full suite), so instead of bailing they
// are capped to DEFAULT_MAX_DISPATCH_PER_PR via a stable-hash subset.
export const DEFAULT_MAX_NEW_FAILURES = 8;

// Hard ceiling on how many advisor analyses auto-dispatch will ever fan out on a
// single PR head. Applies on every path that proceeds past the outage guard; it
// only bites when the failure count is large (i.e. an outage-guard-bypassing PR
// or, in principle, a per-repo maxNewFailures raised above it). The dispatched
// subset is chosen by a stable hash so it is consistent across cron passes.
// Falls back here when a repo doesn't set its own.
export const DEFAULT_MAX_DISPATCH_PER_PR = 32;

// PR labels that bypass the NEW-failure outage guard. `ci-no-td` disables Target
// Determination, so the PR runs the full test suite -- a large failure count is
// expected there and is NOT an outage signal. Such PRs are capped (see
// DEFAULT_MAX_DISPATCH_PER_PR) rather than bailed.
export const OUTAGE_GUARD_BYPASS_LABELS = ["ci-no-td"];

export interface AdvisorRepoConfig {
  // The workflow_dispatch file (on the repo's default branch) that runs the
  // advisor analysis for this repo.
  workflowFile: string;
  // Auto-dispatch bails entirely if a PR has more than this many NEW failures
  // (outage guard), unless the PR carries an OUTAGE_GUARD_BYPASS_LABELS label.
  // Falls back to DEFAULT_MAX_NEW_FAILURES when unset.
  maxNewFailures?: number;
  // Hard ceiling on advisor analyses dispatched per PR head (stable-hash subset
  // when exceeded). Falls back to DEFAULT_MAX_DISPATCH_PER_PR when unset.
  maxDispatchPerPr?: number;
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
    maxDispatchPerPr: 32,
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

// The hard ceiling on advisor analyses dispatched per PR head, per repo.
export function getMaxDispatchPerPr(owner: string, repo: string): number {
  return (
    getAdvisorRepoConfig(owner, repo)?.maxDispatchPerPr ??
    DEFAULT_MAX_DISPATCH_PER_PR
  );
}
