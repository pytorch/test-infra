# Onboarding a repo

The steps that take a `pytorch` org repo from no GreenLight to `mode: active` in its own
`.github/greenlight/config.yml` ([REPOS.md](REPOS.md)), in order. Each names who does it and how it is
checked. A step that another doc owns is linked, not repeated.

Who: **a repo admin** of the onboarded repo, **a `pytorch` org admin**, **an org owner**, **a PR to
test-infra** (reviewed by its code owners), **GreenLight's owners** (who cut and pin its releases and
read its logs), and **the repo's maintainers**.

## Before the config

1. **The pinned scan release.** GreenLight's owners. The `greenlight-scan` release pinned in the
   `greenlight-scan` entry of `runners/common/Terrafile` (README, "Deployment") knows every key and
   value the repo's config uses: `safety: gate` ([GATE.md](GATE.md), "Onboarding a gate repo", step
   1), `eligibility: write_permission`, and any newer key, which an older release treats as unknown
   (REPOS.md, "Outcomes"). Check, before the first repo besides `pytorch/pytorch` opts in:
   - the release has run with `pytorch/pytorch` alone: compare, against the previous release, its
     run's Phase A and Phase B request counts ([SCAN.md](SCAN.md), "Budgets, quota and rate limits"),
     the planner's duration, and its dispatch decisions (`dispatched review for PR` and `deferred PR`
     lines);
   - its release asset cannot be replaced: the release is immutable, or the asset's digest is pinned
     where it is deployed.
2. **The repo's rules.** A repo admin. Check, with an admin token, every ruleset on the branch:
   - everything [GATE.md](GATE.md)'s "Onboarding a gate repo" step 2 lists (every repo but
     `pytorch/pytorch` is a `gate` repo: `pytorchbot` is refused elsewhere, REPOS.md "Outcomes");
   - the repo is public (the scan's live checks refuse it otherwise; REPOS.md, "Live checks");
   - tag and release-branch rules that GreenLight's App cannot bypass;
   - the default branch requires review from code owners, and `CODEOWNERS` owns `/.github/greenlight/`
     and the `CODEOWNERS` file itself (REPOS.md, the top): GreenLight's approval cannot satisfy a code
     owner review, which keeps it from merging changes to the repo's own GreenLight config and policy.
3. **The labels.** A repo admin creates `GL/approved`, `GL/human` and `GL/superseded`
   ([STATUS_LABELS.md](STATUS_LABELS.md), "Deployment"). Check: the repo's label list names all three.
4. **The gate, or Dr. CI.** For `safety: gate`, [GATE.md](GATE.md)'s "Onboarding a gate repo" step 3:
   an org owner adds the repo to the gate's organization ruleset at a pinned SHA. For
   `status_comment: drci`, REPOS.md's "Dr. CI as the status surface".
5. **The control plane, in pytorch/test-infra.** A PR to test-infra, once, before test-infra opts in:
   code owners on every GreenLight path in `CODEOWNERS`, on every workflow and action (any workflow can
   name the environment that holds GreenLight's App key), and on the HUD's auth and dependency files,
   and test-infra's own review policy naming them as merge authorization. Check:
   `tests/test_codeowners.py`.
6. **Size.** GreenLight's owners. A `github` repo's full tick lists every open PR and must fit its
   worker's budgets ([SCAN.md](SCAN.md), "Budgets, quota and rate limits": `OTHER_REPO_REQUEST_BUDGET`,
   400 requests, and the worker's deadline). A gate repo's approval-backing check reads every open PR
   once per 15-minute window on top once it is `active` ([GATE.md](GATE.md), "Gate repos"). Check: the
   repo's open PR count and its in-scope PRs against those numbers. A repo that does not fit uses
   `change_source: clickhouse` when HUD covers it (CHANGE_DETECTION.md), or waits.

## Opting in, in shadow

1. **The App, the config and the policy**, as REPOS.md's "Opting a repo in" lists them: a repo owner
   who may manage GitHub Apps for the repo (a repo admin, unless the `pytorch` org restricts that) adds
   the repo to the GreenLight App's existing `pytorch` installation, or asks any `pytorch` org admin to
   add it; then the repo commits `.github/greenlight/config.yml` with `mode: shadow`, and its review
   policy, `.github/greenlight/review.md`. Check, in the repo's CI or by hand:
   `greenlight check-config` on the config and `.claude/hooks/greenlight/repo-policy.py check` on the
   policy, both with `--repo`.
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

   - the repo's run request counts, for its cost each tick;
   - for a gate repo, the scan's approval-backing line ends `gate rules enforced` on every run, and the
     safety phase fits ([GATE.md](GATE.md), "Onboarding a gate repo", steps 5 and 6).

## Active

1. **The flip.** Once each of GATE.md's write-access checks has its outcome recorded (on
   pytorch/test-infra, below) and, where GATE.md names a remedy for that outcome (check 5's), the
   remedy is in place, a test-infra PR
   adds the repo to `GATE_ACTIVE_REPOS`, then a config PR on the repo sets `mode: active`
   ([GATE.md](GATE.md), "Onboarding a gate repo", step 7; REPOS.md, "Switching from shadow to
   active").
2. **Active validation.** GreenLight's owners, on the first fresh eligible PR after the flip. Check:
   - the record job's eligibility check passes, and its row is not shadow;
   - GreenLight's approval is on the reviewed head (the review's commit is the row's `head_sha`);
   - for `status_comment: greenlight`, GreenLight's comment appears on the PR.
3. **Contributor docs.** The repo's maintainers land them in the repo: who GreenLight reviews, what its
   verdict does on a PR, that a human approval satisfies the review requirement while the gate still
   applies, and how to report a wrong verdict.

## pytorch/test-infra, the first gate repo

pytorch/test-infra skips the shadow phase and the flip: it is `active` from the change that lands its
config, and the other steps above still come first. [GATE.md](GATE.md)'s "Checks that need write
access" run on it once it is active, with each outcome recorded; check 2, which posts a check run
named like the gate's job on a real pull request, needs Jean Schmidt's go before it runs.

## Reporting a wrong verdict

HUD's "Report a wrong verdict" route (`torchci/pages/api/greenlight/report.ts`) accepts only logins
with write access to `pytorch/pytorch` or listed in `torchci/lib/auth/allowList.json`
(`torchci/lib/auth/githubAuth.ts`), and only for repos the HUD renders: those in `GREENLIGHT_REPOS`
(`torchci/lib/greenlight/greenlightConfig.ts`). On any other repo, and for maintainers with neither
access, a wrong verdict is reported by opening an issue in pytorch/test-infra that names the PR and
the verdict.
