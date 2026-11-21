# Repos GreenLight serves (`repos.yaml`)

`greenlight/repos.yaml` lists every repo GreenLight serves and how. The loader is
`repo_config.py`; the per-repo decisions of a scan are in `repo_scan.py`.

```yaml
repos:
  - repo: pytorch/pytorch
    status_comment: drci        # drci | greenlight
    safety: pytorchbot          # pytorchbot | gate
    eligibility: merge_rules    # merge_rules | write_permission
    mode: active                # shadow | active | off
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

`repos` is a list so the loader sees duplicates. Every value is read as a string: a bare `off` is
the mode `off`, not a YAML boolean.

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
  `pytorchbot` outside `constants.PYTORCHBOT_GUARDED_REPOS`; `drci` outside
  `constants.DRCI_STATUS_COMMENT_REPOS`; `safety: gate` with `mode: active`, which this release
  cannot serve safely.

The primary entry, `pytorch/pytorch`, is never refused. Its `status_comment`, `safety` and
`eligibility` are pinned to the built-in values above: a different value is logged and ignored,
so a config edit cannot widen whom GreenLight approves there. Unknown keys on it are logged and
ignored, and its `mode` comes from the file. When its entry is missing or duplicated, or its
`mode` is missing or invalid, `pytorch/pytorch` is safety-only: the revert guard and the
ineligible revoke run under the built-in entry, nothing is dispatched, and the scan fails every
tick until the file is fixed. A broken attempt to turn it off therefore stops its dispatches
rather than keeping them going.

`tests/test_repo_config.py` keeps a file with any problem, or a primary entry that differs from
the built-in, from merging.

## Live checks

Before any work, the scan checks what GitHub reports for the repo (`GET /repos/{repo}`): the
entry's name must be the canonical `full_name` exactly, the repo must be public, and its default
branch must be `main`, the base `merge_authz.accepts_base` judges PRs against. A repo failing one
gets no work on that scan and the scan fails. The same checks run in CI, in the `Test` step of
`greenlight-tests.yml` (`GREENLIGHT_LIVE_CONFIG_CHECK=1` with the workflow's read-only token), so
a mis-cased, private or non-`main` entry cannot merge. Everywhere else the tests stay offline.

## Where the config is read

- **Scan**: from `pytorch/test-infra`'s default branch through the contents API, on every scan, so
  a mode change acts on the next tick. A failed read or a broken file serves the last good
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
every open PR (drafts and every author included) and works through a queue: the PRs that had a
ledger row when the pass started, then every open PR by number, so a PR opened or recorded during
the pass is still reached. It reads GreenLight's reviews on at most
`DRAIN_PRS_PER_TICK` (100) of them and dismisses every live approval, keeping a cursor so the next
tick resumes there; a pass ends when the queue has been covered once. A PR found clean is skipped
for the rest of the pass while its `updated_at` is unchanged, and is remembered as clean only once
that `updated_at` is two minutes old (`FINGERPRINT_QUIET`).

The drain logs `drain complete` only after a whole pass that found no live approval, failed on no
PR, and started once no `greenlight-pr-review.yml` run created before the scan first saw the repo
off was still queued, waiting, pending, requested or in progress. Runs do not say which repo they
review, so every older unfinished run counts. Until then each tick logs
`pass N, checked K, dismissed M, not complete: <why>`. A cold start (a new Lambda environment)
moves the off time later, which only delays completion.

To stop serving a repo: set its `mode` to `off`, wait for `drain complete` in the scan's log, then
remove its entry. Removing the entry first leaves any approval it already holds in place.

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
