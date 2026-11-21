// Per-repo gate for the Green Light section of the Dr.CI comment, and
// greenlight's own login.
//
// Pure data with no server-only imports, so it can be imported from both API
// routes and React components.

function normalizeRepoFullName(fullName: string): string {
  return fullName.trim().toLowerCase();
}

// Repos whose greenlight state is rendered into the Dr.CI comment. The greenlight
// service evaluates the repos in greenlight/repos.yaml and posts no comment of its
// own for its status_comment: drci entries; this list must equal those entries
// (greenlight/tests/test_render_sync.py), each a repo Dr.CI serves
// (test/greenlightConfig.test.ts). Folded at construction, so a mixed-case entry
// cannot silently never match.
export const GREENLIGHT_REPOS: string[] = ["pytorch/pytorch"].map(
  normalizeRepoFullName
);

// The canonical key for an owner/repo pair, shared by the gate below and by anything
// that looks greenlight state up by repo.
//
// GitHub resolves owner/name case-insensitively and greenlight's Python gate folds the
// same way (normalize_repo in greenlight/src/greenlight/constants.py). The two gates MUST
// agree on this key: if greenlight suppresses its own comment on a differently-cased repo
// that this side then misses, the PR is left with no status anywhere.
export function greenlightRepoKey(owner: string, repo: string): string {
  return normalizeRepoFullName(`${owner}/${repo}`);
}

// Whether Dr.CI renders greenlight state for this repo.
export function isGreenlightRepo(owner: string, repo: string): boolean {
  return GREENLIGHT_REPOS.includes(greenlightRepoKey(owner, repo));
}

// The repo whose merge rules decide eligibility on this side
// (greenlightEligibility.ts), so the only one Dr.CI shows an eligibility line
// for; elsewhere it renders the recorded state alone. Must equal TARGET_REPO in
// greenlight/src/greenlight/constants.py (greenlight/tests/test_render_sync.py).
export const GREENLIGHT_PRIMARY_REPO = "pytorch/pytorch";

export function isGreenlightPrimaryRepo(owner: string, repo: string): boolean {
  return greenlightRepoKey(owner, repo) === GREENLIGHT_PRIMARY_REPO;
}

// greenlight's bare login, the form a merge_rules.yaml entry would take. isBot
// misses it: only the REST-side "pytorchgreenlight[bot]" is bot-shaped. Must equal
// GREENLIGHT_APP_SLUG in greenlight/src/greenlight/cohort.py.
export const GREENLIGHT_APP_SLUG = "pytorchgreenlight";
