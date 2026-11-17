# Repos GreenLight serves (`repos.yaml`)

`greenlight/repos.yaml` lists every repo GreenLight serves and how. The loader is
`repo_config.py`; the per-repo decisions of a scan are in `repo_scan.py`, and the tick that scans
every repo at once is in `tick.py` (below).

```yaml
repos:
  - repo: pytorch/pytorch
    status_comment: drci        # drci | greenlight
    safety: pytorchbot          # pytorchbot | gate
    eligibility: merge_rules    # merge_rules | write_permission
    mode: active                # shadow | active | off
    change_source: clickhouse   # github | clickhouse (optional, default github)
```

- `status_comment`: `drci` leaves the status to Dr. CI's comment (and pokes Dr. CI after each
  row); `greenlight` has GreenLight post its own comment. Shadow rows get no GreenLight comment on
  any repo.
- `safety`: `pytorchbot` relies on pytorchbot's trymerge reading the ledger at land time
  (`greenlight_guard.py`); `gate` is for repos without pytorchbot.
- `eligibility`: whose PRs carry authority. `merge_rules` reads the repo's own
  `.github/merge_rules.yaml`; a missing or broken file fails that repo's scan, never falling back
  to anything else. `write_permission` counts every User account with push access to the repo
  (`writers.py`); a listing with none fails that repo's scan. Both are described in
  [TRUSTED_AUTHORS.md](TRUSTED_AUTHORS.md).
- `mode`: see "Modes" below.
- `change_source` (optional, default `github`): how the scan finds the PRs that changed. `github`
  polls GitHub's listings; `clickhouse` reads HUD ClickHouse's webhook tables and GitHub's recently
  updated PRs, for a repo HUD covers ([CHANGE_DETECTION.md](CHANGE_DETECTION.md)).
- `full_tick_minutes` (optional, only with `change_source: clickhouse`, 60 to 1440, default 240): the
  repo's full tick, its reconciliation sweep. A `github` repo keeps a full tick every 15 minutes.

`repos` is a list so the loader sees duplicates. Every value but `full_tick_minutes`, an integer, is
read as a string: a bare `off` is the mode `off`, not a YAML boolean.

## Validation

The file as a whole is unreadable when it is not valid YAML, its top level is not a mapping, or
`repos` is missing or not a list. Unknown top-level keys are logged and ignored. Each entry then
ends one of three ways, and every problem is logged and reported by the scan:

- **served**: all of its work.
- **safety-only**: an otherwise valid entry with a key this release does not know. It gets its
  safety work by its known fields and nothing else, so a newer config never takes safety work
  away from an older pinned release, and an older release never serves an entry it does not fully
  understand.
- **refused**: no work at all. `repo` missing or not `pytorch/<name>`; a field missing or outside
  its values; the repo listed twice, compared case-insensitively (every copy is refused);
  `pytorchbot` outside `constants.PYTORCHBOT_GUARDED_REPOS`; `safety: gate` with `mode: active`,
  which this release cannot serve safely; a `change_source` outside its values; a
  `full_tick_minutes` that is not an integer from 60 to 1440, or on an entry whose `change_source`
  is not `clickhouse`.

`status_comment: drci` is accepted for any entry: the HUD renders exactly the `drci` entries, through
`GREENLIGHT_REPOS` in `torchci/lib/greenlight/greenlightConfig.ts`, which must equal them
(`tests/test_render_sync.py`) and name only repos Dr. CI serves (`torchci/test/greenlightConfig.test.ts`).
See "Dr. CI as the status surface" below.

The primary entry, `pytorch/pytorch`, is never refused. Its `status_comment`, `safety` and
`eligibility` are pinned to the built-in values above: a different value is logged and ignored,
so a config edit cannot widen whom GreenLight approves there. Unknown keys on it are logged and
ignored, and its `mode` comes from the file. When its entry is missing or duplicated, or its
`mode` is missing or invalid, `pytorch/pytorch` is safety-only: the revert guard and the
ineligible revoke run under the built-in entry, nothing is dispatched, and the scan fails every
tick until the file is fixed. A broken attempt to turn it off therefore stops its dispatches
rather than keeping them going. Its `change_source` and `full_tick_minutes` also come from the
file; a missing one, or a bad one (logged), is the built-in's: `github` and 240, so an unreadable
or broken entry polls GitHub, the source that is always correct.

`tests/test_repo_config.py` keeps a file with any problem, or a primary entry that differs from
the built-in on anything but `change_source` and `full_tick_minutes`, from merging.

A release older than the one that added `change_source` and `full_tick_minutes` logs and ignores
them on the primary, but makes a non-primary entry carrying either one safety-only: add them to a
non-primary entry only once the pinned scan release knows them.

## Dr. CI as the status surface (`status_comment: drci`)

A `drci` entry posts no GreenLight comment; Dr. CI renders the recorded state in its own comment
(`torchci/lib/greenlight/greenlightComment.ts`), and GreenLight pokes Dr. CI after each row so the
render is prompt. Shadow rows are never rendered, and only a served, `active` entry is poked.

- **pytorch/pytorch** (the primary repo) also gets the eligibility line: on a PR with no row, or
  only shadow rows, or a verdict on an earlier commit, Dr. CI says GreenLight is waiting, that the
  PR can't be reviewed due to `merge_rules.yaml`, or that it is too big
  ([TRUSTED_AUTHORS.md](TRUSTED_AUTHORS.md)). That line is computed from pytorch/pytorch's merge
  rules (`greenlightEligibility.ts`), so no other repo gets it.
- **Any other `drci` repo** gets its recorded non-shadow state alone: nothing on a PR with no row
  or only shadow rows, and a verdict on an earlier commit stays, marked outdated. In this release no
  repo but pytorch/pytorch can be `active` (`gate` cannot be), so such a repo records only shadow
  rows and its Dr. CI comment shows no GreenLight state until it may be active.

**Making a repo `drci`**, in this order:

1. The pinned scan release must include the change that lets the loader accept `drci` for any repo:
   an older release refuses the entry, and every tick fails until the pin moves.
2. One PR adds or changes the entry and adds the repo to `GREENLIGHT_REPOS`. The repo must pass
   torchci's `isDrCIEnabled` and should be in `.github/workflows/update-drci-comments.yml`'s
   matrix (add it in the same PR if missing): that 15-minute sweep is what re-renders a PR after a
   lost poke. Both surfaces go live from the merge: the scan reads `repos.yaml` from main, and
   Vercel deploys torchci from main.
3. Switch to `drci` while the repo is still in shadow: GreenLight never deletes the comments it
   already posted, so a repo switched later keeps a stale GreenLight comment on its open PRs.

Dr. CI rebuilds a PR's comment only when the PR's current head has workflow runs, so a repo whose
CI skips some PRs entirely shows no GreenLight state on them.

## Live checks

Before any work, the scan checks what GitHub reports for the repo (`GET /repos/{repo}`; in the
Lambda, the App installation's repository listing): the
entry's name must be the canonical `full_name` exactly, the repo must be public, and its default
branch must be `main`, the base `merge_authz.accepts_base` judges PRs against. A repo failing one
gets no work on that scan and the scan fails. The same checks run in CI, in the `Test` step of
`greenlight-tests.yml` (`GREENLIGHT_LIVE_CONFIG_CHECK=1` with the workflow's read-only token), with
one more for an `eligibility: merge_rules` entry: its `.github/merge_rules.yaml` must exist, pass the
scan's own checks of the file (`merge_authz.merge_rule_entries`: valid YAML, a list of mappings, each
`approved_by` a list of non-empty strings) and name at least one `approved_by` entry. So a
mis-cased, private or non-`main` entry, or a `merge_rules` one with no usable file, cannot merge.
Everywhere else the tests stay offline.

## Where the config is read

- **Scan**: from `pytorch/test-infra`'s default branch through the contents API, with the dispatch
  token (below), on every scan, so a mode change acts on the next tick. A failed read or a broken file serves the last good
  snapshot and fails the scan after its work; with no snapshot yet, the scan serves the built-in
  `pytorch/pytorch` entry alone and fails after its work. A rate limit stops the scan.
- **Verdict** (the record job): from its own checkout of `greenlight/repos.yaml`, which is the
  config of the commit the review was dispatched at. A repo with no valid entry fails the verdict
  with no row; a `NO_LAND` still dismisses GreenLight's approval first. A missing or unreadable
  file serves the built-in `pytorch/pytorch` entry alone.

## Modes

- **active**: the scan reviews eligible PRs and the verdict carries authority.
- **shadow**: the scan reviews the same PRs, but every dispatch and marker row is shadow, and the
  verdict is shadow whatever the eligibility check says: no approval, any prior GreenLight approval
  dismissed, nothing Dr. CI or the land gate reads, no GreenLight comment. Existing approvals stay
  until a PR is re-reviewed; draining them is `off`'s job. A safety-only entry makes the verdict
  shadow too.
- **off**: the scan dispatches nothing and drains (`drain.py`), below.

### Switching from shadow to active

Nothing is re-reviewed at the switch. A PR whose latest verdict is a shadow one at an unchanged
fingerprint stays decided, and gets an authoritative review once it changes (a push or a human
comment), as any PR does.

### Draining a repo (`off`)

The drain does not trust the ledger, since an approval can exist with no row. Each tick it lists
every open PR (drafts and every author included), reads GreenLight's reviews on at most
`DRAIN_PRS_PER_TICK` (100) of the pass's pending PRs and dismisses every live approval. A PR is
pending while it is open and the pass has not read it successfully, so a PR whose read failed stays
pending and the pass ends only once no open PR is pending. Each tick takes first the PRs the pass has
not tried yet, those that had a ledger row when the pass started before the rest, each by number,
then the PRs whose read failed, the oldest attempt first, so failing PRs never starve the others.

A PR read once is not read again in its pass, however often it is updated. A pass that can complete
the drain (below) started once no older review run was unfinished, and an off repo is never
dispatched and its record jobs read `off`, so no GreenLight approval can appear on a PR after that
pass read it; a PR opened or reopened during the pass is read before the pass ends. In a pass that
cannot complete, an approval an older run posts after its PR was read is dismissed by the next pass,
which reads every PR again.

The drain logs `drain complete` only after a whole pass that found no live approval, failed on no
PR, and started once no `greenlight-pr-review.yml` run created before the scan first saw the repo
off was still queued, waiting, pending, requested or in progress. Runs do not say which repo they
review, so every older unfinished run counts; they are read with the dispatch token. Until then each
tick logs `pass N, checked K, dismissed M, not complete: <why>`. A cold start (a new Lambda
environment) moves the off time later, which only delays completion.

To stop serving a repo: set its `mode` to `off`, wait for `drain complete` in the scan's log, then
remove its entry. Removing the entry first leaves any approval it already holds in place.

## The tick (`review --all-repos`)

The `greenlight-scan` Lambda runs `review --all-repos --ref main --max 30` every two minutes: one
tick over every served and safety-only entry, `pytorch/pytorch` first, then the other served
entries, then the other safety-only ones, each in file order (`tick.py`).

- **Phase A, safety work**, never stopped by a budget or a floor: a `pytorchbot` repo lists its
  PRs and runs the revert guard and the ineligible revoke (`review.prepare`); an `off` repo runs
  its drain slice; a `gate` repo has no Phase A work yet. A safety-only entry stops here.
- **Phase B, optional work**: `pytorch/pytorch` finishes its scan (fan-out, dispatch, label pass),
  stopped only once fewer than `QUOTA_FLOOR_PRIMARY` (1000) requests are left on the installation.
  Then each other served `active` or `shadow` repo, in order, runs its whole scan within
  `OTHER_REPO_TIME_BUDGET` (20 s) and `OTHER_REPO_REQUEST_BUDGET` (400 requests), stopped below
  `QUOTA_FLOOR_OTHERS` (3000) and never past `TICK_DEADLINE`, 110 s after the tick started. A
  repo whose turn starts past that deadline gets no turn.
- A repo whose Phase B is cut short, or that gets no turn, fails the tick when its full tick (or a
  `clickhouse` repo's wide tick) was due: it is not marked done, so it shows every tick until its
  budget is sized. On a
  fast tick it is a warning, and its PRs wait for the next tick. The PRs its Phase B had failed on
  before a cut or a rate limit stopped it always fail the tick, on a fast tick too, and never as a
  failure of the safety work.
- Without the dispatch token (its mint failed) the tick fails and does not read the config: it
  serves only the built-in `pytorch/pytorch` entry and runs only its safety work (the revert guard
  and the ineligible revoke) on its repo token. No other repo gets any work, so no drain runs, and
  Phase B is skipped, since nothing can be dispatched.

**Dispatch cap.** `--max` is shared. While another repo is in Phase B, `min(DISPATCH_RESERVE, max)`
(5) is held back from `pytorch/pytorch`, and the other repos share it plus whatever
`pytorch/pytorch` left, in order, each capped by what is left; once a positive `--max` is used up, the repos left get
no Phase B turn. `--max 0` pauses every repo, each still running with a limit of 0; no `--max`
leaves every repo uncapped.

**Requests and the quota.** Every GitHub client of a repo, its dispatch client included, shares one
request meter (`quota.py`) that counts each request PyGithub sends and each retry urllib3 makes. The
tick reads the installation's quota (`GET /rate_limit`, which costs nothing) at its start, before
each repo's phase that has work and at its end, never once the rate-limit latch below is set,
subtracting what it counted between reads, and logs
each repo's Phase A and Phase B requests with the quota at the start and the end. Not counted: the
config read, the quota reads, the token mints, the installation listing, the live checks on the
environment path, and PyGithub's rare 301, 302 and 202 follow-ups.

**Isolation is cooperative.** Every repo runs in one process. A repo's stop is checked before each
request and each retry and ends its optional work cleanly, but it cannot interrupt a request already
sent or work that makes no GitHub request, such as a ClickHouse read (bounded by its own timeouts:
connect 10 s, read 60 s). Repos other than `pytorch/pytorch` read their eligibility with the
fail-fast client, never the one that waits out a rate limit. Any other failure in a repo is logged
with its traceback and the tick goes on; at the end the tick raises one error naming every repo's
error and every config problem, refused and safety-only entries included. The CLI's soft timeout
(off in the Lambda) aborts the whole tick.

**A rate limit ends the tick's GitHub work.** The quota belongs to the App installation, shared by
every repo and by the review workflows. Every place that catches a rate limit sets one tick-wide
latch, the token mints, the installation listing and the quota read included, and the meter sets it
on a rate-limit response before any retry or `Retry-After` wait. Once it is set, every meter refuses
further requests, and the tick skips every repo and phase left, naming each in its error; a latch
set with nothing left to skip still fails the tick. A dispatch that hits a rate limit stops the
dispatches and the label pass.

**Tokens.** In the Lambda (`app_tokens.py`): a `pytorch/test-infra` token (`actions: write`,
`contents: read`) for the config read, the dispatch and the drain's read of the review runs; a
metadata-only token for `GET /installation/repositories`, which supplies the live checks; and one
token per repo the listing shows and the live checks pass (`pull_requests: write`,
`contents: read`, `members: read`, that repo alone, no `actions`). A repo the installation lacks,
or whose mint fails, gets no work and fails the tick; when the listing itself fails,
`pytorch/pytorch` still gets its token and the others wait for the next tick. A rate limit on the
listing or a mint is no repo's failure: it stops the tick's GitHub work. From the environment
(the CLI and `greenlight-review.yml`): `PYTORCH_GREENLIGHT_GITHUB_TOKEN` for every repo, its live
checks through `GET /repos/{repo}`, and `PYTORCH_GREENLIGHT_DISPATCH_TOKEN` (falling back to the
first) for the config, the dispatch and the review runs. Adding a repo needs its entry, its review
policy file (below) and the App installed on it, and no Terraform change.

`greenlight-review.yml` mints the same two permission sets (`tests/test_review_workflow_tokens.py`
pins them). With `pr`, it rechecks that PR of the repo its `repo` input names (empty for
`pytorch/pytorch`), validated by `greenlight target` (below), and its repo token covers that repo
alone; `repo` without `pr` fails. Without `pr`, the repo token covers every served and safety-only
entry of its checkout's `repos.yaml` and the run is one `--all-repos` tick, so a repo the
installation lacks fails that mint, and that manual scan, loudly.

## Reviewing a repo's PRs

**The review policy.** `.claude/skills/greenlight-review/SKILL.md` is the policy every repo gets:
the procedure, the criteria, the decision order, the output contract and the hard stops that hold
anywhere. Each configured repo `pytorch/<name>` also has
`.claude/skills/greenlight-review/repos/<name>.md`, which adds hard stops and trivial classes and
defines the repo's own terms, each under its own heading: `## User-facing surface`,
`## Merge-gating workflows`, `## Lint gate` and `## Test layout`. A repo file never narrows a
general hard stop; on any conflict the general file wins. Decision step 3, the one class that lands
before the hard stops, is pytorch/pytorch's `### Meta-internal only` alone.
`tests/test_repo_policy_files.py` keeps a configured repo without its file, a file without one of
those headings, that heading in another repo's file, or a symlinked policy file from merging. The
policy replay CI (`greenlight-policy-replay.yml`) runs for every policy change but one limited to
other repos' files, since it replays `pytorch/pytorch` decisions.

**The reviewer workflow.** `greenlight-pr-review.yml` takes an optional `repo` input: empty for
`pytorch/pytorch` (the scan sends none for it, `dispatch.py`), else a configured repo's canonical
name. Every job first runs `greenlight target` (`workflow_target.py`), which checks the inputs
against its own checkout's `repos.yaml` and prints the values every later step uses: an exact
served or safety-only entry (a non-empty spelling of `pytorch/pytorch` is refused), a plain PR
number, a 40-hex head SHA, the checkout directory (`pytorch` for `pytorch/pytorch`, `target`
otherwise), the policy file and whether it exists, and whether Dr. CI renders the status (a served,
active `drci` entry). The App tokens cover the reviewed repo alone. The review job deletes every
other repo's policy file before the model runs; a repo without its file gets a canned `NO_LAND`
(`review_error`) with no model, which the record job records, dismissing as any `NO_LAND` does.
The record job reads mode, safety and eligibility from its own checkout (`verdict`), never from
the dispatch.

**Concurrency.** A newer dispatch for the same PR cancels the older run. `pytorch/pytorch` keeps
the group `greenlight-pr-review-<pr_number>`, chosen only by an empty `repo`; every other repo uses
`greenlight-pr-review-<repo>:<pr_number>`. GitHub evaluates the group before any job and compares
group names ignoring case, so a dispatch naming a case variant of another configured repo joins
that repo's group and cancels its running review before its own jobs refuse the name. Dispatching
needs `actions: write` on `pytorch/test-infra`, which cancels runs anyway, and the scan dispatches
the PR again.

## Caches and the TTL trade-off

The scan keeps, between scans in one process (a warm Lambda or a `--loop` daemon), the repos
config, read every scan and served stale on any failure but a rate limit, and each repo's
eligibility source, kept for `PYTORCH_GREENLIGHT_MERGE_RULES_TTL_SECONDS` (600 s). A transient
failure (a GitHub 5xx, a network error or timeout) serves the last eligibility snapshot for at most
three TTLs; a broken or missing source, or a rate limit, fails the repo's scan at once. `--pr`
rechecks share the caches but never the tick memory.

So a change to `merge_rules.yaml`, or to who can push to a write_permission repo, reaches the scan
within the TTL rather than on the next tick. The record job's eligibility check reads the rules, or
the author's permission, live, so no new approval follows a removal. The
ineligible revoke reaches only listed PRs, and the listing keeps cohort authors only, so an author
who leaves the cohort keeps an approval already given until it is dismissed by hand.

## Modules

The modules the per-repo config, the drain, the tick and change detection added to `src/greenlight/`
(the rest are in README.md's "Layout"):

```text
repo_config.py        # load and validate repos.yaml: served, safety-only and refused entries, the built-in primary entry
repo_scan.py          # one entry's decisions on both entry points: live checks, eligibility source and cache, its work (drain, review or none)
snapshot_cache.py     # the TTL-bounded snapshot of the repos config and each eligibility source, with a per-failure stale policy
drain.py              # an off repo's drain: dismiss every live greenlight approval, a bounded slice per tick
review_finish.py      # a review scan's optional work (fan-out, dispatch, label pass, refusals) and its error aggregation
workflow_target.py    # `greenlight target`: the review workflows' input validation and the values their steps use
writers.py            # write_permission eligibility: the repo's push-access Users as one synthetic merge rule, and the record-time check
author_eligibility.py # the record job's live eligibility check for one PR, by the repo's eligibility source
tick.py               # one tick over every configured repo: Phase A safety work, then Phase B optional work
tick_outcomes.py      # how a tick's steps ended (cut, rate limit, failure) and the shared dispatch cap
quota.py              # per-tick request metering at PyGithub's and urllib3's seams, the rate-limit latch and the quota gauge
app_tokens.py         # the Lambda's App tokens: the dispatch token, the installation listing and one token per repo
change_feed.py        # HUD ClickHouse's webhook tables: each PR's marker and the tables' freshness (CHANGE_DETECTION.md)
pr_view.py            # a clickhouse repo's view of its open PRs and their last markers, kept between ticks
change_listing.py     # a listing tick's kind (full, wide, event, or a github repo's full or fast) and its candidates
```
