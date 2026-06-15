---
name: release-cherry-pick-missing-reverts
description: Find reverts that landed on pytorch/pytorch main but are missing from a release branch (release/X.Y) because the reverted commit was already shipped in a release candidate, and open one cherry-pick PR per missing revert against the release branch (on a fork branch, never pushing to release/X.Y directly). Driven by tools/analytics/github_analyze.py --analyze-missing-reverts-from-branch (the "GitHub Analytics Daily" workflow). Triggered by "missing reverts", "analyze reverts for release", "cherry-pick missing reverts", "reverts not in release/X.Y", or pointing at a GitHub Analytics Daily run and asking to cherry-pick the flagged reverts.
---

# Release: Cherry-pick missing reverts

When a commit ships in a release candidate (so it is on `release/X.Y`) and is
later **reverted on `main`**, the revert does not automatically reach the
release branch — the buggy commit is still present in `release/X.Y`. These are
**missing reverts**: the revert must be cherry-picked onto the release branch.

This skill finds those missing reverts and opens **one cherry-pick PR per
revert** against `pytorch/pytorch:release/X.Y`, each on its own branch in the
user's fork. It never pushes to `release/X.Y` directly.

The detector is `tools/analytics/github_analyze.py` (run daily by the
`GitHub Analytics Daily` workflow). It is the same script this skill lives
next to in **test-infra**, but the cherry-picks operate on a **pytorch/pytorch**
checkout.

## Inputs

| Input | Required | Example | Notes |
|-------|----------|---------|-------|
| **Release branch** | yes | `release/2.13` | The branch to cherry-pick reverts onto. |
| **Source** | one of | a GHA run URL, or "run the analyzer" | Either a `GitHub Analytics Daily` run URL/ID whose log already has the analysis, or run the analyzer locally for fresh data. |
| **pytorch/pytorch path** | yes (for cherry-pick) | `~/pytorch` | A checkout with `upstream` → `pytorch/pytorch` and `origin` → the user's fork. |
| **Fork remote** | defaults to `origin` | `origin` | Where the cherry-pick branches are pushed. |

If the release branch was not supplied, ask for it before doing anything — do
not guess.

## When to use this skill

Use when the user asks to:
- Find / list **missing reverts** for a release branch
- Cherry-pick the reverts flagged by the analytics run to `release/X.Y`
- Act on a `GitHub Analytics Daily` run that printed
  `🔴 WARNING: This is possibly a revert of a commit that was included in a release candidate`

## Background: what "missing revert" means and how it is flagged

`analyze_reverts_missing_from_branch` compares `main` against the release branch
and, for every revert that is on `main` but not on the release branch, checks
whether the **reverted** commit carries a release-candidate tag
(`v[0-9]+.[0-9]+.[0-9]+-rc[0-9]+`). Three outcomes per revert:

- `🔴 WARNING ...` — the reverted commit shipped in an RC, so it is (likely) in
  `release/X.Y`. **This is a missing revert — act on it.**
- `✅ DETECTED: The reverted commit ... was cherry-picked to <branch>` — the
  revert is already on the release branch. **Skip.**
- `🟢 STATUS: ... may not be needed` — the reverted commit was never in the
  release branch. **Skip.**

Each flagged entry prints, in order:

```
Reverted GitHub Commit: <reverted_sha>          # the bad commit still in release/X.Y
🏷️  Tags matching ... : v2.13.0-rc1 ...          # proof it shipped in an RC
Commit Hash: <revert_sha>                        # the revert commit on main -> cherry-pick THIS
Author / Date / Title: Revert "<orig title> (#<PR>)"
🔴  WARNING: ...
```

The value to cherry-pick is **`Commit Hash`** (the revert commit on `main`), not
the reverted commit.

## Step 1 — Get the list of missing reverts

**Option A — from a referenced run** (when the user points at a
`GitHub Analytics Daily` run):

```bash
# Find the github-analyze job id for the run, then fetch its log.
gh api repos/pytorch/test-infra/actions/runs/<RUN_ID>/jobs \
  -q '.jobs[] | select(.name=="github-analyze") | .id'
gh api repos/pytorch/test-infra/actions/jobs/<JOB_ID>/logs > /tmp/ghanalyze.log
```

**Option B — run the analyzer locally** (preferred for fresh data; the CI log
can be stale). From a pytorch/pytorch checkout with `upstream` →
`pytorch/pytorch`:

```bash
git -C <pytorch> fetch upstream main release/X.Y --tags
python test-infra/tools/analytics/github_analyze.py \
  --repo-path <pytorch> --remote upstream \
  --branch release/X.Y --analyze-missing-reverts-from-branch | tee /tmp/ghanalyze.log
```

## Step 2 — Parse the flagged reverts

Extract every entry whose status line is `🔴 WARNING`. For each, capture:
- `revert_sha` ← the `Commit Hash:` line (cherry-pick target)
- `reverted_sha` ← the `Reverted GitHub Commit:` line
- `pr` ← the `#NNNN` in the `Title:` line (the original PR that was reverted)
- `title` ← the `Title:` text

A revert with `✅ DETECTED` or `🟢 STATUS` is **not** missing — skip it. Report
the counts (flagged vs skipped) so nothing is silently dropped.

## Step 3 — One cherry-pick PR per missing revert

Operate on the pytorch/pytorch checkout. For each flagged revert:

```bash
REL=release/X.Y
git -C <pytorch> fetch upstream "$REL" main --tags
BR="cherry-pick-revert-<PR>-${REL#release/}"     # e.g. cherry-pick-revert-185760-2.13
git -C <pytorch> checkout -B "$BR" "upstream/$REL"
git -C <pytorch> cherry-pick -x <revert_sha>
```

- `-x` records `(cherry picked from commit <revert_sha>)` in the message.
- **On conflict:** do **not** force-resolve blindly. Report the conflicting
  files for that revert, run `git cherry-pick --abort`, and leave it out of the
  PR batch (note it in the summary as "needs manual cherry-pick"). Continue with
  the others.

Push to the fork and open the PR against the release branch:

```bash
git -C <pytorch> push origin "$BR"
gh pr create --repo pytorch/pytorch --base "$REL" --head "<fork-owner>:$BR" \
  --title "[$REL] Revert \"<orig title> (#<PR>)\"" \
  --body "<see PR body below>"
```

**Never** push to `release/X.Y` itself, and never open the PR with `--base main`.

### PR body

```
Cherry-pick of the main-branch revert <revert_sha> onto release/X.Y.

The reverted commit <reverted_sha> (#<PR>) shipped in a release candidate
(v X.Y.0-rcN) and is present in release/X.Y, but the revert only landed on
main. This cherry-picks the revert so release/X.Y matches main.

Detected by tools/analytics/github_analyze.py --analyze-missing-reverts-from-branch
(GitHub Analytics Daily). Cherry-pick (-x): (cherry picked from commit <revert_sha>).

This PR was authored with the assistance of an AI coding agent.
```

## Step 4 — Summary

Report a table: PR, original title, revert_sha, and outcome — `PR #<n> opened`,
`skipped (already on <branch>)`, or `conflict — needs manual cherry-pick`.
Include the new branch names and PR URLs.

## Guardrails

- **Confirm before opening PRs.** Creating multiple cherry-pick PRs is an
  outward-facing action — list what will be opened and confirm first.
- **Never push to `release/X.Y`**; only to fork branches, PRs target the release
  branch for review.
- **Skip non-missing reverts** (`✅ DETECTED` / `🟢 STATUS`).
- **Stop on cherry-pick conflicts** for that revert (abort + report); do not
  hand-resolve unless the user asks.
- Requires `gh` authenticated for `pytorch/pytorch` and a pytorch checkout whose
  `origin` is the user's fork.
