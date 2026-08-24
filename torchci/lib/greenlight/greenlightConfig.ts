// Per-repo gate for the Green Light section of the Dr.CI comment.
//
// Pure data with no server-only imports, so it can be imported from both API
// routes and React components.

function normalizeRepoFullName(fullName: string): string {
  return fullName.trim().toLowerCase();
}

// Repos whose greenlight state is rendered into the Dr.CI comment. The greenlight
// service only ever evaluates TARGET_REPO (greenlight/src/greenlight/constants.py);
// this list controls the read-back side independently of it. Folded at construction,
// so a mixed-case entry cannot silently never match.
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

// Whether Dr.CI can render greenlight state for this repo at all, independent of whether
// the section is currently switched on.
export function isGreenlightRepo(owner: string, repo: string): boolean {
  return GREENLIGHT_REPOS.includes(greenlightRepoKey(owner, repo));
}

// Read at call time rather than module load so tests can mutate process.env.
export function isGreenlightEnabled(owner: string, repo: string): boolean {
  return (
    process.env.DRCI_GREENLIGHT_COMMENT_ENABLED === "true" &&
    isGreenlightRepo(owner, repo)
  );
}
