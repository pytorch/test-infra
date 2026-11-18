# Onboarding a repo

The steps that take a repo from no GreenLight to an `active` entry in `repos.yaml`
([REPOS.md](REPOS.md)), in order. Each names who does it and how it is checked. A step that another
doc owns is linked, not repeated.

Who: **an org owner** of the repo's org, **a repo admin** of the onboarded repo, **a PR to
test-infra** (reviewed by its code owners), **GreenLight's owners** (who cut and pin its releases and
read its logs), and **the repo's maintainers**.

## Before the entry

1. **The pinned scan release.** GreenLight's owners. The `greenlight-scan` release pinned in the
   `greenlight-scan` entry of `runners/common/Terrafile` (README, "Deployment") knows every key and
   value the entry uses: `safety: gate` ([GATE.md](GATE.md), step 1), `eligibility: write_permission`,
   and any newer key, which an older release treats as safety-only or refuses (REPOS.md,
   "Validation"). Check, before the entry lands:
   - the release has run with the existing entries alone: compare, against the previous release, the
     scan's per-repo request line (`<repo>: N GitHub request(s) in Phase A, M in Phase B; ...`), the
     tick's duration, and `pytorch/pytorch`'s dispatch decisions (`dispatched review for PR` and
     `deferred PR` lines);
   - its release asset cannot be replaced: the release is immutable, or the asset's digest is pinned
     where it is deployed.
2. **The repo's rules.** A repo admin. Check, with an admin token, every ruleset on the branch:
   - everything [GATE.md](GATE.md)'s "Onboarding a gate repo" step 2 lists (every repo but
     `pytorch/pytorch` is a `gate` repo: `pytorchbot` is refused elsewhere, REPOS.md "Validation");
   - the repo is public (the scan's live checks refuse it otherwise; REPOS.md, "Live checks");
   - tag and release-branch rules that GreenLight's App cannot bypass;
   - for a repo that hosts GreenLight's control plane (test-infra itself), the `main` ruleset
     requires review from code owners: GreenLight's approval cannot satisfy it, which is what keeps
     its approval from merging changes to GreenLight's own paths;
   - for a repo that hosts GreenLight's control plane, the `main` ruleset dismisses stale approvals on
     push: otherwise a code owner's approval of an older commit keeps counting after a push, and
     GreenLight then approves the new head.
3. **The labels.** A repo admin creates `GL/approved`, `GL/human` and `GL/superseded`
   ([STATUS_LABELS.md](STATUS_LABELS.md), "Deployment"). Check: the repo's label list names all three.
4. **The gate, or Dr. CI.** For `safety: gate`, [GATE.md](GATE.md)'s "Onboarding a gate repo" steps
   1 and 3: the pinned release has the gate, and an org owner adds the repo to the gate's organization
   ruleset. For `status_comment: drci`, REPOS.md's "Making a repo `drci`".
5. **The control plane, where the repo hosts it.** A PR to test-infra: code owners on every
   GreenLight path in `CODEOWNERS`, and the repo's policy file naming them as merge authorization.
   Every other path gets a default owner, a team of the repo's writers, so GreenLight's approval
   alone merges nothing there: an `active` entry gives the repo GreenLight's reviews, labels and
   comment, and every merge still takes a human writer's approval. GitHub accepts a team as a code
   owner only when it is visible and has write access, and otherwise leaves its paths unowned. A
   path is freed for GreenLight's approval alone only by a `CODEOWNERS` line with no owners, for a
   path outside every hard stop of the repo's policy. Check: `tests/test_codeowners.py`, whose live
   check reads GitHub's `codeowners/errors` for the commit and must find none.
6. **Size.** GreenLight's owners. A `github` repo's full tick lists every open PR and must fit the
   per-repo budgets of Phase B: `OTHER_REPO_REQUEST_BUDGET` (400 requests) and
   `OTHER_REPO_TIME_BUDGET` (20 s) in `constants.py` (REPOS.md, "The tick"). A gate repo's backing
   check reads every open PR once per 15-minute window on top ([GATE.md](GATE.md), "Gate repos"). Check:
   the repo's open PR count and its in-scope PRs against those numbers. A repo that does not fit uses
   `change_source: clickhouse` when HUD covers it ([CHANGE_DETECTION.md](CHANGE_DETECTION.md)), or
   waits. The first served repo besides `pytorch/pytorch` also changes `pytorch/pytorch`'s dispatch
   cap: `DISPATCH_RESERVE` (5) of `--max` is held back from it whenever another repo is served
   (REPOS.md, "The tick", **Dispatch cap**), so compare `pytorch/pytorch`'s dispatch decisions again after the entry
   lands.
7. **GreenLight's App on the repo**, once the steps above hold. An org owner installs it. Check: the
   App installation's repository list names the repo; once the entry lands, a repo the installation
   lacks gets no work and fails the tick (REPOS.md, "The tick").

## The entry, in shadow

1. **The config PR.** A PR to test-infra adds the repo's entry with `mode: shadow` and its policy file
   `.claude/skills/greenlight-review/repos/<name>.md` (REPOS.md, "Reviewing a repo's PRs"). Check: CI
   (`tests/test_repo_config.py`, `tests/test_repo_policy_files.py`).
2. **The shadow phase.** The repo's maintainers and GreenLight's owners. Check:
   - the shadow verdicts against the human decisions on the same PRs, the latest shadow verdict per PR
     from the ledger:

     ```sql
     SELECT pr_number, head_sha, status, reason, version
     FROM misc.greenlight_pr_state
     WHERE repo = 'pytorch/<name>' AND shadow = true AND status IN ('LAND', 'NO_LAND')
     ORDER BY pr_number, run_id DESC, version DESC
     LIMIT 1 BY pr_number
     ```

   - the scan's per-repo request line, for the repo's cost each tick;
   - for a gate repo, the approval-backing line ends `gate rules enforced` on every tick, GATE.md's
     open checks pass, and the safety phase fits ([GATE.md](GATE.md), "Onboarding a gate repo", steps
     5 and 6).

## Active

1. **The flip.** A config PR to test-infra sets `mode: active` (REPOS.md, "Switching from shadow to
   active"; GATE.md, "Onboarding a gate repo", step 7).
2. **Active validation.** GreenLight's owners, on the first fresh eligible PR after the flip. Check:
   - the record job's eligibility check passes, and its row is not shadow;
   - GreenLight's approval is on the reviewed head (the review's commit is the row's `head_sha`);
   - for `status_comment: greenlight`, GreenLight's comment appears on the PR.
3. **Contributor docs.** The repo's maintainers land them in the repo: who GreenLight reviews, what its
   verdict does on a PR, that a human approval satisfies the review requirement while the gate still
   applies, and how to report a wrong verdict.

## Reporting a wrong verdict

HUD's "Report a wrong verdict" route (`torchci/pages/api/greenlight/report.ts`) accepts only logins
with write access to `pytorch/pytorch` or listed in `torchci/lib/auth/allowList.json`
(`torchci/lib/auth/githubAuth.ts`), and only for repos the HUD renders: those in `GREENLIGHT_REPOS`
(`torchci/lib/greenlight/greenlightConfig.ts`), the `status_comment: drci` entries. On any other repo,
and for maintainers with neither access, a wrong verdict is reported by opening an issue in
pytorch/test-infra that names the PR and the verdict.
