# Repos GreenLight serves (`.github/greenlight/config.yml`)

Each repo GreenLight serves holds its own config at `.github/greenlight/config.yml` on its default
branch. The directory also holds the repo's GreenLight review policy file. The modules involved are
listed under "Modules" below.

A repo's own config decides whom GreenLight approves there, so its owners should protect the
directory with both a CODEOWNERS line for `/.github/greenlight/` and branch protection's "Require
review from Code Owners" on the default branch: a CODEOWNERS line alone only requests their review.
The same owners must own the CODEOWNERS file itself (`/CODEOWNERS`, `/.github/CODEOWNERS` or
`/docs/CODEOWNERS`, whichever the repo uses), or a PR that drops the `/.github/greenlight/` line
needs no owner review. GreenLight itself must never be a code owner of either.

```yaml
status_comment: greenlight    # drci | greenlight
safety: gate                  # pytorchbot | gate
eligibility: merge_rules      # merge_rules | write_permission
mode: shadow                  # shadow | active | off
# minimum_role: maintain      # write | maintain; optional, only with eligibility: write_permission
# change_source: clickhouse   # github | clickhouse; optional, default github
# full_tick_minutes: 240      # 60 to 1440; optional, only with change_source: clickhouse
```

- `status_comment`: `drci` leaves the status to Dr. CI's comment (and pokes Dr. CI after each
  row); `greenlight` has GreenLight post its own comment. Shadow rows get no GreenLight comment on
  any repo.
- `safety`: `pytorchbot` relies on pytorchbot's trymerge reading the ledger at land time
  (`greenlight_guard.py`); `gate` is for repos without pytorchbot: a required workflow and the
  scan's approval-backing check keep GreenLight's approval to the commit it reviewed
  ([GATE.md](GATE.md), which also holds the gate's onboarding steps; the whole flow is in
  [ONBOARDING.md](ONBOARDING.md)).
- `eligibility`: whose PRs carry authority. `merge_rules` reads the repo's own
  `.github/merge_rules.yaml`; a missing or broken file fails that repo's scan, never falling back
  to anything else. `write_permission` counts every User account with push access to the repo
  (`writers.py`); a listing with none fails that repo's scan. Both are described in
  [TRUSTED_AUTHORS.md](TRUSTED_AUTHORS.md).
- `mode`: see "Modes" below.
- `minimum_role`: optional, for `eligibility: write_permission` only. `write` (the default when the
  key is absent) counts push access; `maintain` counts only the maintain and admin roles.
- `change_source` (optional, default `github`): how the scan finds the PRs that changed. `github`
  polls GitHub's listings; `clickhouse` reads HUD ClickHouse's webhook tables and GitHub's recently
  updated PRs, for a repo HUD covers, and only for the repos in
  `constants.CLICKHOUSE_CHANGE_SOURCE_REPOS` ([CHANGE_DETECTION.md](CHANGE_DETECTION.md)).
- `full_tick_minutes` (optional, only with `change_source: clickhouse`, an integer from 60 to 1440,
  default 240): the repo's full tick, its reconciliation sweep. A `github` repo keeps a full tick
  every 15 minutes.

An older pinned scan release reads either of the last two as an unknown key: add them only once
the pinned release knows them.

## Opting a repo in

GreenLight serves repos of the `pytorch` org only, through its App's one `pytorch` installation, and a
repo opts in by itself, with no change to GreenLight:

1. A repo owner who may manage GitHub Apps for the repo (a repository admin, unless the `pytorch` org
   restricts App installation by repository admins) adds the repo to the GreenLight App's existing
   `pytorch` installation. A repo owner without that permission asks any `pytorch` org admin to add
   it.
2. They commit `.github/greenlight/config.yml`, `mode: shadow` first, and protect it as above.
3. They commit the repo's review policy, `.github/greenlight/review.md`, in the same directory (see
   "Reviewing a repo's PRs"). Without a valid one every review of the repo declines with a
   `review_error` `NO_LAND`.

The file names no repo: it belongs to the repo it sits in. Every value but `full_tick_minutes`, an
integer, is read as a string: a bare `off` is the mode `off`, not a YAML boolean. `greenlight check-config PATH --repo OWNER/NAME`
validates a file offline as the scan would read it, printing every problem and exiting non-zero on
any.

## Outcomes

Every problem is logged and reported by the scan.

| The file | Any other repo | `pytorch/pytorch` |
| --- | --- | --- |
| absent (a 404) | not configured: no work | served under the built-in entry, no problem |
| valid | served | served under the built-in entry with the file's `mode` |
| valid with an unknown key | safety-only | served (the key is ignored) |
| invalid | refused: no work | safety-only under the built-in entry |
| unreadable | the last file read; with none, no work | the last file read; with none, served under the built-in entry |
| rate limited | the scan stops | the scan stops |

- **invalid**: not valid YAML (any exception while parsing, deeply nested brackets included), an
  anchor or alias anywhere, a key given twice, its top level not a mapping, over `CONFIG_MAX_BYTES`
  (8192 bytes), a directory, or any tag written in the file (`!!str`, `!!merge`, a `%TAG` handle,
  a verbatim `!<...>` tag): no valid config needs one. A bare `<<` is a plain, unknown key. For any repo but
  `pytorch/pytorch` also: a field missing or outside its values; `pytorchbot` outside
  `constants.PYTORCHBOT_GUARDED_REPOS`; `drci` outside `constants.DRCI_STATUS_COMMENT_REPOS`;
  `safety: gate` with `mode: active` outside `constants.GATE_ACTIVE_REPOS` (a test-infra change under
  GreenLight's code owners: GATE.md); `minimum_role` with
  any `eligibility` but `write_permission`; `clickhouse` outside
  `constants.CLICKHOUSE_CHANGE_SOURCE_REPOS`; `full_tick_minutes` that is not an integer from 60 to
  1440, or without `change_source: clickhouse`. Only `minimum_role`, `change_source` and
  `full_tick_minutes` may be absent.
- **safety-only**: the repo gets its safety work by its known fields and nothing else. An unknown
  key makes a repo safety-only so a newer config never takes safety work away from an older pinned
  release, and an older release never serves a file it does not fully understand.
- **unreadable**: any read failure but a 404 or a rate limit (a GitHub 5xx, a network error or
  timeout, a 403). The scan then serves the last file read, kept in its config cache (the scan
  Lambda's in its state store, a CLI scan's in its process). A failed read so neither stops a repo
  nor turns an `off` or `shadow` one `active`; the scan still fails after its work. With nothing kept
  (a first read), `pytorch/pytorch` is served under the built-in entry, so a config failure never
  stops it, and any other repo gets no work.

The config cache adds rules on top of these, from what it stored of earlier reads
([SCAN.md](SCAN.md)): an invalid file is safety-only under the repo's last valid settings; a
served repo whose file is removed is drained as `off`; and `pytorch/pytorch`'s file removed after
a valid one leaves it safety-only under its last valid settings, never back to `active`.

## `pytorch/pytorch`

The primary repo is never refused. Its `status_comment`, `safety`, `eligibility` and `minimum_role`
are pinned to the built-in entry (`drci`, `pytorchbot`, `merge_rules`, `write`, mode `active`): a
different or missing value is logged and ignored (an absent `minimum_role` is not reported), so a
config edit cannot widen whom GreenLight approves there. Unknown keys on it are logged and ignored
too; only its `mode`, `change_source` and `full_tick_minutes` come from the file, and a bad value of
either of the last two is logged and ignored, its built-in value (`github`, 240) kept. Its file spells out
the built-in values with mode `active`, and `greenlight check-config` reports every value it pins
or ignores as a problem, so a CI check running it can keep the file truthful.

When its file is invalid, or its `mode` is missing or invalid, `pytorch/pytorch` is
safety-only: the revert guard and the ineligible revoke run under the built-in entry (under its
last valid settings when the config cache kept some, so an `off` one keeps draining), nothing is
dispatched, and the scan fails every tick until the file is fixed. A broken attempt to turn it off
therefore stops its dispatches rather than keeping them going. With no file at all it is served under the built-in
entry, unless the config cache kept a valid one.

## Dr. CI as the status surface (`status_comment: drci`)

A `drci` repo posts no GreenLight comment; Dr. CI renders the recorded state in its own comment
(`torchci/lib/greenlight/greenlightComment.ts`), and GreenLight pokes Dr. CI after each row so the
render is prompt. Shadow rows are never rendered, and only a served, `active` repo is poked.

- **pytorch/pytorch** also gets the eligibility line: on a PR with no row, or only shadow rows, or a
  verdict on an earlier commit, Dr. CI says GreenLight is waiting, that the PR can't be reviewed due
  to `merge_rules.yaml`, or that it is too big ([TRUSTED_AUTHORS.md](TRUSTED_AUTHORS.md)). That
  line is computed from pytorch/pytorch's merge rules (`greenlightEligibility.ts`), so no other repo
  gets it.
- **Any other `drci` repo** gets its recorded non-shadow state alone: nothing on a PR with no row or
  only shadow rows, and a verdict on an earlier commit stays, marked outdated. Until a `gate` repo is
  `active` with its gate enforced ([GATE.md](GATE.md)), it records only shadow rows, and its Dr. CI
  comment shows no GreenLight state.

**Making a repo `drci`**, in this order:

1. A pytorch/test-infra PR adds the repo to `constants.DRCI_STATUS_COMMENT_REPOS` and to torchci's
   `GREENLIGHT_REPOS` (`tests/test_render_sync.py` holds the two equal). The repo must pass torchci's
   `isDrCIEnabled` (`torchci/test/greenlightConfig.test.ts`) and should be in
   `.github/workflows/update-drci-comments.yml`'s matrix (add it in the same PR if missing): that
   15-minute sweep re-renders a PR after a lost poke. torchci deploys with the merge.
2. A greenlight-scan release including that PR is pinned. An older release reads `drci` in the
   repo's file as invalid: a repo it already served keeps only its safety work, under its last valid
   settings, with no reviews, and the planner fails on the tick the problem first appears, then warns,
   until the pin moves ([SCAN.md](SCAN.md)).
3. The repo's own `.github/greenlight/config.yml` switches to `status_comment: drci`, while the repo
   is still in shadow: GreenLight never deletes the comments it already posted, so a repo switched
   later keeps a stale GreenLight comment on its open PRs.

Dr. CI rebuilds a PR's comment only when the PR's current head has workflow runs, so a repo whose CI
skips some PRs entirely shows no GreenLight state on them.

## Live checks

Before any work, the scan checks what GitHub reports for the repo: the scanned name must be the
canonical `full_name` exactly, the repo must be public and not archived, and its default branch
must be `main`, the base every repo's rule judges PRs against (`merge_authz.accepts_base_for`: on a
`gate` repo, `main` alone). A CLI scan reads
`GET /repos/{repo}` first and refuses a private or archived repo before it reads its config. The scan
Lambda's planner reads the App installation's listing of its repos, and each worker reads
`GET /repos/{repo}` again with its repo's own token before any work, so a repo turned private since
the planner read it gets none. A repo failing one gets no work on that scan and the scan fails; in
the Lambda `pytorch/pytorch`'s Phase A has already run by then, and only its Phase B is held back.

## Where the config is read

Always from the repo's default branch through the contents API, never from a PR head.

- **Scan**: the scan Lambda revalidates the file every tick through its config cache: an unchanged
  file costs a 304, and an absent one is asked again only ten minutes after its last 404, so a mode
  change acts on the next tick and a new file within about ten minutes ([SCAN.md](SCAN.md)). A CLI
  scan goes through the same config cache with the scan's token, kept in its process (a one-shot
  starts empty). `review --repo` naming a repo with no file fails the scan.
- **Verdict** (the record job): at record time, with the job's token, through the patient client the
  eligibility check uses (it rides out a short rate limit). A `LAND` or `NO_LAND` on a
  repo with no usable settings (no file outside `pytorch/pytorch`, an invalid file, any read
  failure but a 404) fails with no row; a `NO_LAND`, or a `LAND` the dispatch marks shadow, still
  dismisses GreenLight's approval first.
  An invalid `pytorch/pytorch` file makes the verdict shadow, as safety-only repos do.
- **Markers** (`CANCELLED`, `FAILED`, `AI_REVIEW_STARTED`) never fail closed on the read: on any
  failure, a missing token included, `pytorch/pytorch` falls back to its built-in entry, served,
  and any other repo's marker is shadow.

## Modes

- **active**: the scan reviews eligible PRs and the verdict carries authority.
- **shadow**: the scan reviews the same PRs, but every dispatch and marker row is shadow, and the
  verdict is shadow whatever the eligibility check says: no approval, any prior GreenLight approval
  dismissed, nothing Dr. CI or the land gate reads, no GreenLight comment. Existing approvals stay
  until a PR is re-reviewed; draining them is `off`'s job. On a `gate` repo the approval-backing check
  also keeps running on the PRs with a ledger row and withdraws an approval no `LAND` backs
  ([GATE.md](GATE.md)). A safety-only repo makes the verdict shadow too.
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
tick logs `pass N, checked K, dismissed M, not complete: <why>`. A repo whose stored memory is lost
or cannot be read starts cold, which moves the off time later and only delays completion. Once the
drain is complete no new pass starts while the repo stays off: the scan Lambda gives such a repo no
worker at all (its outcome is `drained`) until its file stops saying `off`, and a CLI scan logs that
it is complete and reads nothing. The first run after a change away from `off` forgets the drain, so
a later switch back to `off` drains again.

To stop serving a repo, set its `mode` to `off` or remove its file: the scan drains a served repo
whose file is removed as `off`, and stops serving it once the drain completes. Uninstall the
App from the repo only after `drain complete` in the scan's log: a repo the installation no longer
reaches cannot be drained, so any approval GreenLight already holds there stays, and the scan fails
every tick until the App is back and the drain completes.

## The scan

The scan Lambda's planner scans `pytorch/pytorch` itself, its safety work first, and invokes one
worker per other repo with work; every Lambda scan of a repo holds that repo's lease, and the
invocations share their state (leases, scan memory, config cache, eligibility snapshots, the
rate-limit latch) in a DynamoDB table. Its order, budgets, quota floors, dispatch caps, rate-limit
handling, concurrency and rollout are in [SCAN.md](SCAN.md).

**Tokens.** In the Lambda (`app_tokens.py`): a `pytorch/test-infra` token (`actions: write`,
`contents: read`) for the dispatch and the drain's read of the review runs; a metadata-only token
for `GET /installation/repositories`, which supplies the live checks; `contents: read` tokens for
the planner's config reads; and one token per scanned repo (`pull_requests: write`,
`contents: read`, `members: read`, that repo alone, no `actions`). A repo whose mint fails gets no
work and fails the tick; a rate limit on the listing or a mint stops the invocation's GitHub work.
From the environment (the CLI and `greenlight-review.yml`): `PYTORCH_GREENLIGHT_GITHUB_TOKEN` for
the repo, its live checks included, and `PYTORCH_GREENLIGHT_DISPATCH_TOKEN` (falling back to the
first) for the dispatch and the review runs. Adding a repo needs only its file and the repo added to
the App's installation ("Opting a repo in"), and no Terraform change.

`greenlight-review.yml` scans one repo, its `repo` input (default `pytorch/pytorch`): with `pr` it
rechecks that PR, without it it scans the repo once, with no lease and no stored state. It mints the
same two permission sets as the Lambda (`tests/test_review_workflow_tokens.py` pins them), its repo
token covering that repo alone.

## Reviewing a repo's PRs

The scan dispatches `greenlight-pr-review.yml` with the PR's repo as its `repo` input, empty for
`pytorch/pytorch` (so its concurrency group, `greenlight-pr-review-<pr>`, is unchanged; any other repo's
is `greenlight-pr-review-<repo>:<pr>`). Every job first runs `greenlight target` (`workflow_target.py`)
and uses only its outputs (`repo`, `name`, `pr`, `head_sha`, `checkout`, `drci_poke`):

- `--strict` (`announce_start`, the review job, and the record job when the review exported nothing):
  the inputs' shapes (an empty repo is `pytorch/pytorch`, which no other spelling names; `pytorch/<name>`;
  the PR number; the head SHA), then, for any repo but `pytorch/pytorch`, the live checks above and a
  served or safety-only config, read with the job's read-only token. `pytorch/pytorch` makes no read.
- `--from-review` (the record job when the review succeeded): the `repo` and `drci_poke` the review job
  exported, checked again with no read, the repo against what the dispatch's own `repo` input names;
  `name` and `checkout` are derived from the repo. So no read stands before the App-token mint on the one
  path that can dismiss an approval.

Both modes require the head SHA.

Each App token is minted for the validated repo alone. The reviewed repo is checked out under
`./pytorch` for `pytorch/pytorch` and `./target` for any other repo, and a sparse checkout of its
`main` takes `.claude/skills` and `.github/greenlight`. The sanitize step restores that `.claude/skills`
into the checkout without its `greenlight-review` skill, so the checkout holds no copy of GreenLight's
policy, the built-in `repo-policy.md` that pytorch/test-infra's `main` carries included.

**The review policy.** The general policy (`.claude/skills/greenlight-review/SKILL.md` in
`pytorch/test-infra`) reads one repository policy at `.claude/skills/greenlight-review/repo-policy.md`.
`.claude/hooks/greenlight/repo-policy.py stage` fills that slot from the repo's
`.github/greenlight/review.md` on `main`, read from git objects, never through the filesystem (the
directories must be trees and the file a regular blob, so no symlink is followed). The file must be
UTF-8, at most 64 KiB, and have the sections `## User-facing surface`, `## Merge-gating workflows`,
`## Lint gate` and `## Test layout`; `### Meta-internal only` is required for `pytorch/pytorch` and refused
elsewhere. `repo-policy.py check FILE --repo OWNER/NAME` runs those checks offline, for a repo's own CI.
`pytorch/pytorch` keeps the built-in policy in that slot until its own file exists; any other repo
without a valid file has no slot. Only `main` counts: a PR's own `review.md` is reviewed as data.

**Canned verdicts.** Before the model, in this order, the review job copies a canned `NO_LAND` from
`.claude/hooks/greenlight/` and skips the model: `review_error` (`no-policy-verdict.json`) when no valid
policy was staged; `not_trivial` (`greenlight-files-verdict.json`) when the diff touches
`.github/greenlight/` (the path itself, anything under it, either side of a rename or copy) or
`.github/` itself, or a header `repo-policy.py touches` cannot parse, so GreenLight never approves a
change to a repo's own config or policy; `scope_too_large` (`too-large-verdict.json`) from the size gate. The record job records
and dismisses on them as on any `NO_LAND`.

**Policy replay.** The policy replay CI (`greenlight-policy-replay.yml`) runs for every change to what
a review reads or runs, as its `on.push.paths` lists them. The torchci workflow's replay tests fail
when the review workflow's shape, the local action it uses included, is not one the replay registers
(`tools/torchci/greenlight_replay/PARITY.md`).

**Residual.** GitHub compares concurrency group names case-insensitively and evaluates them from the
raw input, so a case variant of another repo's name joins that repo's group and can cancel its run;
its own run then fails `greenlight target`. Dispatching needs `actions: write`, which can cancel runs
anyway.

## Caches and the TTL trade-off

The scan keeps each repo's eligibility source, one cache per repo, `eligibility` and
`minimum_role`, for `PYTORCH_GREENLIGHT_MERGE_RULES_TTL_SECONDS` (600 s): in the Lambda's state
store across invocations, and in the process for a CLI scan or a `--loop` daemon. A transient failure (a GitHub 5xx, a network
error or timeout) serves the last eligibility snapshot for at most three TTLs; a broken or missing
source, or a rate limit, fails the repo's scan at once. `--pr` rechecks share the caches but never
the tick memory. A `gate` repo's approval-backing check keeps its own part of the repo's stored memory
(`backing_memory.py`: what each PR was last read at, when each was last tried, the sweep and the waiting
PRs); its rules are read
on every run, never cached.

So a change to `merge_rules.yaml`, or to who holds a write_permission repo's minimum role, reaches
the scan within the TTL rather than on the next tick. The record job's eligibility check reads the
rules, or the author's permission, live, so no new approval follows a removal. The ineligible revoke
reaches only listed PRs, and the listing keeps cohort authors only, so an author who leaves the
cohort keeps an approval already given until it is dismissed by hand.

## Modules

The modules the per-repo config, the drain, the scan Lambda and change detection added to
`src/greenlight/` (the rest are in README.md's "Layout"):

- `repo_config.py`: judges a repo's config file (`Settings`), for the scan, the verdict, the markers
  and `check-config`; `config_yaml.py`: its strict YAML loader; `config_contents.py`: the one
  judgement of the contents API's answer.
- `repo_scan.py`: one repo's decisions on both entry points: its settings, the live checks, its
  eligibility cache, then its work (`repo_work`: a drain, a review, or a gate repo's backing check
  alone); `scan_repo` is the CLI's scan.
- `review.py`: the scan's safety work (listing, state read, revert guard, ineligible revoke);
  `review_finish.py`: its optional work (fingerprint fan-out, dispatch, label pass, refusals) and
  its error aggregation.
- `drain.py`: the `off` drain; `drain_pass.py`: one pass of it, and its stored form;
  `scan_memory.py` keeps its progress between ticks, with the stored form the state store keeps;
  `fingerprint_cache.py`: one listing tick's reuse of the kept fingerprint results.
- `change_listing.py`: a listing tick's kind and candidates by the repo's `change_source`;
  `change_feed.py`: HUD ClickHouse's webhook tables, each PR's marker and the tables' freshness;
  `pr_view.py`: a `clickhouse` repo's view of its open PRs and their last markers, and its stored
  form ([CHANGE_DETECTION.md](CHANGE_DETECTION.md)).
- `snapshot_cache.py`: the TTL cache each repo's eligibility source is read through.
- `workflow_target.py`: `greenlight target`, the reviewer workflow's input gate ("Reviewing a repo's PRs").
- `writers.py`: `write_permission` eligibility: the holders of the repo's minimum role as one rule
  for the scan, and one author's role for the verdict.
- `author_eligibility.py`: the verdict's live eligibility check (`has_eligible_author`), from either
  source.
- `lambda_handler.py`: the Lambda entry point, the planner or a worker by the event;
  `fanout.py`: the planner; `fanout_repos.py`: its fan-out over the other repos; `worker.py`: one
  repo's worker; `leased_run.py`: the steps both take around a repo's run under its lease.
- `tick.py`: one repo's run in an invocation, Phase A then Phase B; `tick_outcomes.py`: how its
  steps ended (cut, rate limit, failure).
- `config_cache.py`: the cache of each repo's config file and the store-aware rules, for the Lambda
  and the CLI.
- `state_store.py`: the shared state (leases, memory, config cache, eligibility, latch) and its
  in-process backend; `state_dynamo.py`: its DynamoDB backend.
- `quota.py`: per-invocation request metering at PyGithub's and urllib3's seams and the quota gauge;
  `latch.py`: the rate-limit latch and how it follows the store's shared latch.
- `app_tokens.py`: the Lambda's App tokens: the dispatch token, the installation listing, the
  contents tokens and one token per repo.
- The gate ([GATE.md](GATE.md)): `approvals.py`, GreenLight's review logic (live approvals, the
  gate's predicate, the review reader, dismissals); `gate_check.py`, `greenlight gate-check`, the poll
  the gate workflow runs; `gate_rules.py`, whether a gate repo's branch rules enforce the gate;
  `land_approval.py`, the record job's approval (pinned, re-read, re-given after a push) and its gate
  check; `approval_backing.py`, a gate repo's Phase A check, which withdraws every live approval the
  ledger does not back; `backing_judge.py`, its rules for one approval; `backing_reads.py`, its reads
  in one run; `backing_memory.py`, what it keeps between runs.
