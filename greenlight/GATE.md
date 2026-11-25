# GreenLight's gate (`safety: gate`)

How GreenLight keeps its approval from counting for a commit it did not review, on a repo merged
through GitHub's own required approvals instead of pytorchbot. `safety` is set in each repo's own
`.github/greenlight/config.yml` ([REPOS.md](REPOS.md)); `pytorch/pytorch` keeps `pytorchbot`, whose
trymerge reads the ledger at land time.

GitHub counts an approval given on an older commit: unless the repo dismisses stale approvals, an
approval stays after a push. In pytorch/test-infra (1 approval required, stale dismissal off), 17 of
100 merged PRs sampled on 2026-11-17 merged with every approval on a commit older than the merged
head. Two parts close that gap for GreenLight's approval: a required workflow, the **gate**, that
holds a PR while GreenLight's approval is on a commit other than the head, and GreenLight's own checks
that withdraw an approval the ledger does not back.

## The gate

**What it decides** (`approvals.gate_decision`): it **holds** while any live GreenLight review (state
`APPROVED`, from `pytorchgreenlight[bot]` exactly, user type `Bot`) is on a commit other than the
PR's head; otherwise it **passes**. A PR with no GreenLight approval passes: it still needs an approval
under the repo's own rules. The gate does not wait for a new verdict, so it never deadlocks on a PR
GreenLight will not review again (a human decided, a draft, an ineligible author, a `Stale` label, the
24-hour window). It holds on any live approval on another commit, not only GreenLight's latest review,
since GitHub documents that a dismissal turns a review into a comment and does not say how its count
treats the approval before it.

**How it runs** (`greenlight gate-check`, `gate_check.py`): it reads the PR and every page of its
reviews with conditional requests (an unchanged page answers 304, which costs no rate-limit request)
and checks at once, then after 60, 120 and 240 seconds and every 300 seconds after. Any error counts as
holding. It passes as soon as no live GreenLight approval on another commit remains (GreenLight
dismissed it, or approved the head). When the PR's head has stayed on another commit for 5 minutes, or
the PR is closed on two reads 60 seconds apart, the run exits failing: its commit no longer decides a
merge, and the run for the new head does. After `--timeout-minutes` (default 300, at most 340) it
fails, naming the approval that still stands; re-run it once GreenLight withdrew or renewed its
approval.

**The workflow** (`.github/workflows/greenlight-gate.yml`): one job, `gate`, with no `if`, no
`continue-on-error` and no concurrency group (GitHub's ruleset docs warn against `cancel-in-progress`
in a ruleset workflow). It checks that the workflow defining it is
`pytorch/test-infra/.github/workflows/greenlight-gate.yml` at a 40-hex commit (`job.workflow_*`, which
it logs), checks out `greenlight/` from that commit, installs Python 3.13 and uv from pinned actions
with no cache, and runs `gate-check` with the run's `GITHUB_TOKEN` (`contents: read`,
`pull-requests: read`). Every file it runs is code-owned: the workflow and `/greenlight/`
(`CODEOWNERS`). `tests/test_gate_workflow.py` keeps these properties. Its `paths` filter limits the
ordinary run in test-infra to PRs that change the gate; a ruleset ignores filters.

## The trigger

**An organization ruleset "Require workflows to pass before merging"** requires the gate: source
repository `pytorch/test-infra`, path `.github/workflows/greenlight-gate.yml`, pinned to a commit SHA
(no branch), targeting the gate repos' default branch. Only an org owner creates or changes it, and a
PR cannot change the pinned workflow, so a test-infra merge alone does not change any repo's gate. The
pytorch org is on GitHub Enterprise Cloud, which this rule needs (repo rulesets in `evaluate` mode
exist, a GHEC-only feature).

How a ruleset workflow behaves (GitHub docs):

- It runs on `opened`, `synchronize` and `reopened` only. A PR open when the ruleset is created, or
  when its pin moves, and a PR retargeted to the default branch, has no run until a push, an update of
  its branch, or a close and reopen.
- It does not run on events a `GITHUB_TOKEN` triggers: a PR such automation pushes stays blocked; push
  it with an App or user token instead.
- It blocks direct pushes to the branches it targets, except by its bypass actors.
- A first-time contributor's fork run waits for a maintainer's approval; a PR with a merge conflict
  has no `pull_request` run until the conflict is resolved.
- In test-infra the same file also runs as an ordinary workflow on PRs that change the gate; the
  ruleset counts only its own run.

**Rejected: a caller workflow with a required status check**, through `pull_request_target` (its
check does land on the PR head) or a `pull_request` caller pinned by SHA. Any person or integration
with write access can set any status check, and a writer can post a passing check run of the gate's
name from a workflow on another branch; code owners on `.github/workflows/` stop such a workflow from
merging, not from running. Writers are the cohort GreenLight serves, so GreenLight does not accept a
required check as a wired gate (below).

## GreenLight's side

On every repo, `pytorch/pytorch` included (`land_approval.py`, called from `verdict`):

1. The approval is pinned to the reviewed commit (`commit_id`).
2. Right after approving, the record job reads the PR again; when its head moved, or its base is no
   longer accepted, it dismisses GreenLight's approvals. When that read fails, it dismisses the review
   it just created and fails.
3. It keeps an existing approval only when GreenLight's latest review (the one pytorchbot's trymerge
   reads) is an approval on the reviewed head and every live GreenLight approval is on that head;
   otherwise it dismisses them and approves again, pinned. On `pytorch/pytorch` a LAND after a push
   therefore dismisses the old approval and posts a new one.
4. A `NO_LAND`, or a `LAND` passed `--shadow`, dismisses before any lookup; every dismissal keeps the
   client's retry of server and network errors.

## Gate repos

**The rules check** (`gate_rules.py`). The gate counts as enforced when the repo's default branch
(`main`) shows all of, through the rules API and the branches API:

- a `workflows` rule naming repository `pytorch/test-infra`, path
  `.github/workflows/greenlight-gate.yml`, a 40-hex `sha`, and no other `ref`;
- a `pull_request` rule requiring at least 1 approval;
- no `pull_request` rule restricting who can dismiss reviews: GreenLight must be able to withdraw its
  approval, or an approval on the head that a later `NO_LAND` cannot dismiss would pass the gate;
- no merge queue;
- no classic branch protection (`protection.enabled` false): rulesets alone, so the check sees every
  rule, a classic dismissal restriction included.

The record job runs the check before its eligibility check, for a `LAND` that would carry authority,
and approves only as `pytorchgreenlight[bot]`, the account the gate watches; when the gate is not
enforced, or the job runs as another App, the verdict is recorded in shadow, and a failed read fails
the command. The scan reads the rules on every run of a gate repo's worker and logs the answer (enforced,
or the problems): an `active` gate repo whose gate is not enforced, or whose read failed, gets no
dispatch that run (its error), since a shadow review's `LAND` would stay decided.

**The approval-backing check** (`approval_backing.py`, `backing_judge.py`), in the safety phase of a
gate repo's worker, for every gate repo that is not `off`. GreenLight's live approval **stands** only when the gate
is enforced, the approval is on the PR's current head, the base is `main`, and the PR's latest
non-shadow ledger row (the one pytorch's land guard would read) is a `LAND` for that head. Otherwise
it is dismissed, after a fresh read of the PR. One wait: an approval on the head whose latest row is
missing, an in-flight marker, a `LAND` for another head, or a `NO_LAND`, `CANCELLED` or `FAILED` older
than the approval, is kept while the ledger holds no row more than 2 minutes newer than the approval
(its own `LAND` row may not be ingested yet), for at most 30 minutes. A newer non-`LAND` row, or a
`REVERTED` one, withdraws it at once, and a gate found not enforced withdraws every GreenLight approval
in the repo.

On an `active` repo, each run lists every open PR (drafts and every author included) and reads
GreenLight's reviews on every PR with a non-shadow verdict or a review in flight whose state (updated
time, head, base, latest row, the rules' answer) changed since it last read it, on every other PR it read
before whose state changed (a push, a retarget, a new review), on the PRs left waiting, and on a slice of
a sweep that reads every open PR within each 15-minute window (a sweep that misses its window is the
repo's error). A `shadow` repo never gets an approval from GreenLight, so its runs read only the PRs with
a ledger row (every PR GreenLight ever approved has one) and run no sweep. What the check knows between
runs is kept in the repo's stored scan memory ([SCAN.md](SCAN.md)). A run starts no read 120 s after its
invocation started; the changed and waiting PRs get the first half of that, then the sweep's slice, then
the rest, and a changed or waiting PR left unread is the repo's error (it is read next run). The ledger
reads have their own 20 s bound. The Lambda mints new tokens every run and GitHub ties an ETag to its
token, so these reads get no 304: the sweep costs one reviews read per open PR per window (about 1,500
requests an hour for 380 open PRs), and a PR's unchanged state is what keeps it from being read in
between. When ClickHouse cannot be read, it still withdraws approvals on another commit or base, leaves
the rest for the next run, and reports the error. A failed rules read leaves the PRs it reads waiting
until a read succeeds. It logs, each run, how many PRs it read and how long it took.

**Base rule**: in a gate repo the base must be `main` and the repo's default branch must be `main`,
in the listing, the `--pr` gate, the record job and its re-read (`merge_authz.accepts_base_for`);
ghstack and native-stack bases count only on `pytorchbot` repos.

**Windows the gate does not close**, each withdrawn by the record job's re-read or the backing check's
next run: an approval posted just after the gate passed on a newer commit (the push race); a PR
retargeted from `main` to a branch whose own rules accept one approval but do not require the gate
(GitHub keeps approvals on a retarget unless the branch dismisses stale ones); an approval an old
record job posts when re-run by hand after a newer `NO_LAND`, which waits on the ledger like any fresh
approval before it is withdrawn.

**A withdrawal is not undone.** An approval withdrawn while its `LAND` still stands (the ledger stalled
past 30 minutes, the gate found not enforced) is not given again while the PR's fingerprint is
unchanged. It comes back with a push or a comment by a merge-authorized login (a new review), and a
human approval merges the PR meanwhile. So never take the gate's ruleset through `evaluate` or
`disabled`: edit its pinned SHA in place.

## Evidence

Checked read-only on 2026-11-17:

- an approval on an older commit counts toward required approvals (above);
- a GitHub App cannot satisfy code-owner review: code owners are people or teams with write access;
- the org can use ruleset workflows (Enterprise Cloud) and has no organization ruleset yet;
- a `pull_request_target` run's checks land on the PR's head commit;
- `GET /repos/{o}/{r}/branches/main` shows classic protection to a read token (`protection.enabled`:
  false on test-infra and pytorch, true on executorch and vision);
- GitHub's native "dismiss stale approvals" withdraws every approval, human ones included, on a push;
- an ordinary `pull_request` run of the gate in test-infra reports `job.workflow_repository`
  `pytorch/test-infra`, `job.workflow_file_path` `.github/workflows/greenlight-gate.yml` and
  `job.workflow_sha` the PR's merge commit, and its checkout and `gate-check` run end to end (about 10 s
  to a pass on a PR with no GreenLight approval).

**Checks that need write access**, run in pytorch/test-infra's shadow phase as the first gate repo,
before it goes `active`. None of them blocks the shadow phase from starting:

1. A ruleset run's `job.workflow_repository`, `job.workflow_file_path` and `job.workflow_sha` (the gate
   logs them) name `pytorch/test-infra`, the gate's path and the pinned SHA. Anything else makes the
   gate fail on every PR.
2. A check run named like the gate's job, posted from another workflow, and test-infra's ordinary run of
   a PR's own copy of the gate, do not satisfy the workflows rule.
3. An App approval created with an older `commit_id` counts toward the required approval (the gate
   holds on it either way).
4. GreenLight dismisses its own approval under the repo's rules.
5. A PR whose head moves back to a commit whose gate passed earlier: can it merge before the new run
   registers? If so, require `require_last_push_approval` or native stale dismissal as well.
6. Moving the ruleset's pinned SHA: do open PRs need a new run?

## Onboarding a gate repo

1. The `greenlight-scan` Lambda's pinned release includes the gate (this change) before any gate repo
   is `active`; an older release refuses `gate` with `active` and has no backing check.
2. The repo's default branch is `main` and uses rulesets only (no classic protection), with at least 1
   required approval, no restriction on who can dismiss reviews, and no merge queue. Record the choice on
   GitHub's native stale dismissal: it closes the gap for human approvals too, and dismisses them.
3. An org owner adds the repo to the gate's organization ruleset: the workflows rule at a pinned SHA
   of `pytorch/test-infra` (no branch). Its bypass actors are only actors that also bypass every rule
   requiring an approval (check every ruleset on the branch with an admin token); otherwise a bypasser
   merges on a stale approval. Open PRs need a push, an update or a reopen to get their first run.
4. GreenLight's App is installed on the repo; its own `.github/greenlight/config.yml` (`safety: gate`,
   `mode: shadow`) and review policy land on its default branch ([REPOS.md](REPOS.md)).
5. In shadow, run the write-access checks above (once, on the first gate repo), and confirm the scan's
   rules line for the repo reads enforced (it names any missing rule; the record job does not run the
   check on a shadow verdict).
6. The repo fits an active run: its open PRs are swept every 15 minutes and its PRs with a verdict read
   when they change (about 0.35 s a read, at most 120 s of reads a run), and its stored memory stays under
   the scan's cap (about 60 bytes a PR); the scan logs the counts and the time each run.
7. A test-infra PR adds the repo to `GATE_ACTIVE_REPOS` (`greenlight/src/greenlight/constants.py`, under
   GreenLight's code owners: a repo's maintainers cannot go active alone), then a config PR on the repo
   flips its file to `active`. For pytorch/test-infra, whose config file lives beside GreenLight's code, a
   CODEOWNERS line on `/.github/greenlight/` comes first.

**Moving the pin**: review the full diff, between the old and the new SHA, of the workflow and of
`greenlight/`, then edit the ruleset's SHA in place.

## Leaving

Each of these leaves a gate repo with no scan work at all, so its approvals would stand unchecked; switch
the repo to `mode: off` and wait for its drain to complete first:

- **Rolling the Lambda back** past the release that accepts `gate` with `active`: once this release has
  run, the repo's stored last valid config is the active one too, and an older release refuses both.
- **Removing the repo from `GATE_ACTIVE_REPOS`** while its file says `active`: the same refusal.
- **Moving its default branch off `main`**: the scan's identity check then refuses the repo, drain
  included.
