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
- `minimum_role`: optional, for `eligibility: write_permission` only. `write` (the default when the
  key is absent) counts push access; `maintain` counts only the maintain and admin roles.

The file names no repo: it belongs to the repo it sits in. Every value is read as a string: a bare
`off` is the mode `off`, not a YAML boolean. `greenlight check-config PATH --repo OWNER/NAME`
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
| unreadable | the last settings read; with none, no work | the last settings read; with none, served under the built-in entry |
| rate limited | the scan stops | the scan stops |

- **invalid**: not valid YAML (any exception while parsing, deeply nested brackets included), an
  anchor or alias anywhere, a key given twice, its top level not a mapping, over `CONFIG_MAX_BYTES`
  (8192 bytes), a directory, or any tag written in the file (`!!str`, `!!merge`, a `%TAG` handle,
  a verbatim `!<...>` tag): no valid config needs one. A bare `<<` is a plain, unknown key. For any repo but
  `pytorch/pytorch` also: a field missing or outside its values; `pytorchbot` outside
  `constants.PYTORCHBOT_GUARDED_REPOS`; `drci` outside `constants.DRCI_STATUS_COMMENT_REPOS`;
  `safety: gate` with `mode: active`, which this release cannot serve safely; `minimum_role` with
  any `eligibility` but `write_permission`. Only `minimum_role` may be absent.
- **safety-only**: the repo gets its safety work by its known fields and nothing else. An unknown
  key makes a repo safety-only so a newer config never takes safety work away from an older pinned
  release, and an older release never serves a file it does not fully understand.
- **unreadable**: any read failure but a 404 or a rate limit (a GitHub 5xx, a network error or
  timeout, a 403). The scan then serves what it last read: the scan Lambda the last file read,
  kept in its config cache, and a CLI scan the settings of the repo's last read that was not
  unreadable, kept in its process. A failed read so neither stops a repo nor turns an `off` or
  `shadow` one `active`; the scan still fails after its work. With nothing kept (a first read, a
  `--pr` recheck), `pytorch/pytorch` is served under the built-in entry, so a config failure never
  stops it, and any other repo gets no work.

The scan Lambda's config cache adds rules on top of these, from what it stored of earlier reads
([SCAN.md](SCAN.md)): an invalid file is safety-only under the repo's last valid settings; a
served repo whose file is removed is drained as `off`; and `pytorch/pytorch`'s file removed after
a valid one leaves it safety-only under its last valid settings, never back to `active`.

## `pytorch/pytorch`

The primary repo is never refused. Its `status_comment`, `safety`, `eligibility` and `minimum_role`
are pinned to the built-in entry (`drci`, `pytorchbot`, `merge_rules`, `write`, mode `active`): a
different or missing value is logged and ignored (an absent `minimum_role` is not reported), so a
config edit cannot widen whom GreenLight approves there. Unknown keys on it are logged and ignored
too; only its `mode` comes from the file. Its file spells out
the built-in values with mode `active`, and `greenlight check-config` reports every value it pins
or ignores as a problem, so a CI check running it can keep the file truthful.

When its file is invalid, or its `mode` is missing or invalid, `pytorch/pytorch` is
safety-only: the revert guard and the ineligible revoke run under the built-in entry (in the scan
Lambda, under its last valid settings, so an `off` one keeps draining), nothing is dispatched, and
the scan fails every tick until the file is fixed. A broken attempt to turn it off therefore stops
its dispatches rather than keeping them going. With no file at all it is served under the built-in
entry, unless the scan Lambda read a valid one before.

## Live checks

Before any work, the scan checks what GitHub reports for the repo: the scanned name must be the
canonical `full_name` exactly, the repo must be public and not archived, and its default branch
must be `main`, the base `merge_authz.accepts_base` judges PRs against. A CLI scan reads
`GET /repos/{repo}`; the scan Lambda reads the App installation's listing of its repos. A repo
failing one gets no work on that scan and the scan fails; in the Lambda `pytorch/pytorch`'s Phase A
has already run by then, and only its Phase B is held back.

## Where the config is read

Always from the repo's default branch through the contents API, never from a PR head.

- **Scan**: the scan Lambda revalidates the file every tick through its config cache: an unchanged
  file costs a 304, and an absent one is asked again only ten minutes after its last 404, so a mode
  change acts on the next tick and a new file within about ten minutes ([SCAN.md](SCAN.md)). A CLI
  scan reads it on every scan with the scan's token. `review --repo` naming a repo with no file
  fails the scan.
- **Verdict** (the record job): at record time, with the job's token, through the patient client the
  eligibility check uses (it rides out a short rate limit). A `LAND` or `NO_LAND` on a
  repo with no usable settings (no file outside `pytorch/pytorch`, an invalid file, any read
  failure but a 404) fails with no row; a `NO_LAND` still dismisses GreenLight's approval first.
  An invalid `pytorch/pytorch` file makes the verdict shadow, as safety-only repos do.
- **Markers** (`CANCELLED`, `FAILED`, `AI_REVIEW_STARTED`) never fail closed on the read: on any
  failure, a missing token included, `pytorch/pytorch` falls back to its built-in entry, served,
  and any other repo's marker is shadow.

## Modes

- **active**: the scan reviews eligible PRs and the verdict carries authority.
- **shadow**: the scan reviews the same PRs, but every dispatch and marker row is shadow, and the
  verdict is shadow whatever the eligibility check says: no approval, any prior GreenLight approval
  dismissed, nothing Dr. CI or the land gate reads, no GreenLight comment. Existing approvals stay
  until a PR is re-reviewed; draining them is `off`'s job. A safety-only repo makes the verdict
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
tick logs `pass N, checked K, dismissed M, not complete: <why>`. A repo whose stored memory is lost
or cannot be read starts cold, which moves the off time later and only delays completion. Once the
drain is complete no new pass starts while the repo stays off: each later tick logs that it is
complete and reads nothing.

To stop serving a repo, set its `mode` to `off` or remove its file: the scan Lambda drains a served
repo whose file is removed as `off`, and stops serving it once the drain completes. Uninstall the
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
first) for the dispatch and the review runs. Adding a repo needs its file and the App installed on
it, and no Terraform change.

`greenlight-review.yml` scans one repo, its `repo` input (default `pytorch/pytorch`): with `pr` it
rechecks that PR, without it it scans the repo once, with no lease and no stored state. It mints the
same two permission sets as the Lambda (`tests/test_review_workflow_tokens.py` pins them), its repo
token covering that repo alone.

## Caches and the TTL trade-off

The scan keeps each repo's eligibility source, one cache per repo, `eligibility` and
`minimum_role`, for `PYTORCH_GREENLIGHT_MERGE_RULES_TTL_SECONDS` (600 s): in the Lambda's state
store across invocations, and in the process for a CLI scan or a `--loop` daemon. A transient failure (a GitHub 5xx, a network
error or timeout) serves the last eligibility snapshot for at most three TTLs; a broken or missing
source, or a rate limit, fails the repo's scan at once. `--pr` rechecks share the caches but never
the tick memory.

So a change to `merge_rules.yaml`, or to who holds a write_permission repo's minimum role, reaches
the scan within the TTL rather than on the next tick. The record job's eligibility check reads the
rules, or the author's permission, live, so no new approval follows a removal. The ineligible revoke
reaches only listed PRs, and the listing keeps cohort authors only, so an author who leaves the
cohort keeps an approval already given until it is dismissed by hand.

## Modules

The modules the per-repo config, the drain and the scan Lambda added to `src/greenlight/` (the rest
are in README.md's "Layout"):

- `repo_config.py`: reads and judges a repo's config file (`Settings`), for the scan, the verdict,
  the markers and `check-config`.
- `repo_scan.py`: one repo's decisions on both entry points: its settings, the live checks, its
  eligibility cache, then its work (`repo_work`: a drain, a review or none); `scan_repo` is the
  CLI's scan.
- `review.py`: the scan's safety work (listing, state read, revert guard, ineligible revoke);
  `review_finish.py`: its optional work (fingerprint fan-out, dispatch, label pass, refusals) and
  its error aggregation.
- `drain.py`: the `off` drain; `scan_memory.py` keeps its progress between ticks, with the
  stored form the state store keeps.
- `snapshot_cache.py`: the TTL cache each repo's eligibility source is read through.
- `writers.py`: `write_permission` eligibility: the holders of the repo's minimum role as one rule
  for the scan, and one author's role for the verdict.
- `author_eligibility.py`: the verdict's live eligibility check (`has_eligible_author`), from either
  source.
- `lambda_handler.py`: the Lambda entry point, the planner or a worker by the event;
  `fanout.py`: the planner; `fanout_repos.py`: its fan-out over the other repos; `worker.py`: one
  repo's worker.
- `tick.py`: one repo's run in an invocation, Phase A then Phase B; `tick_outcomes.py`: how its
  steps ended (cut, rate limit, failure).
- `config_cache.py`: the Lambda's cache of each repo's config file and the store-aware rules.
- `state_store.py`: the shared state (leases, memory, config cache, eligibility, latch) and its
  in-process backend; `state_dynamo.py`: its DynamoDB backend.
- `quota.py`: per-invocation request metering at PyGithub's and urllib3's seams, the rate-limit
  latch and the quota gauge.
- `app_tokens.py`: the Lambda's App tokens: the dispatch token, the installation listing, the
  contents tokens and one token per repo.
