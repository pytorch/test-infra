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
  timeout, a 403). The scan then serves the settings of the repo's last read that was not
  unreadable, kept in the process's memory for the repo, so a failed read neither stops a repo nor
  turns an `off` or `shadow` one `active`; the scan still fails after its work. With nothing kept (a
  cold start, a `--pr` recheck), `pytorch/pytorch` is served under the built-in entry, so a config
  failure never stops it, and any other repo gets no work.

## `pytorch/pytorch`

The primary repo is never refused. Its `status_comment`, `safety`, `eligibility` and `minimum_role`
are pinned to the built-in entry (`drci`, `pytorchbot`, `merge_rules`, `write`, mode `active`): a
different or missing value is logged and ignored (an absent `minimum_role` is not reported), so a
config edit cannot widen whom GreenLight approves there. Unknown keys on it are logged and ignored
too; only its `mode` comes from the file. Its file spells out
the built-in values with mode `active`, and `greenlight check-config` reports every value it pins
or ignores as a problem, so a CI check running it can keep the file truthful.

When its file is invalid, or its `mode` is missing or invalid, `pytorch/pytorch` is
safety-only: the revert guard and the ineligible revoke run under the built-in entry, nothing is
dispatched, and the scan fails every tick until the file is fixed. A broken attempt to
turn it off therefore stops its dispatches rather than keeping them going. With no file at all it
is served under the built-in entry.

## Live checks

Before any work, the scan checks what GitHub reports for the repo (`GET /repos/{repo}`): the
scanned name must be the canonical `full_name` exactly, the repo must be public, and its default
branch must be `main`, the base `merge_authz.accepts_base` judges PRs against. A repo failing one
gets no work on that scan and the scan fails.

## Where the config is read

Always from the repo's default branch through the contents API, never from a PR head.

- **Scan**: on every scan, with the scan's token, so a mode change acts on the next tick. The last
  settings read are kept only for an unreadable read to serve. `review --repo` naming a repo with no
  file fails the scan.
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
moves the off time later, which only delays completion. Once the drain is complete no new pass
starts while the repo stays off: each later tick logs that it is complete and reads nothing.

To stop serving a repo: set its `mode` to `off`, wait for `drain complete` in the scan's log, then
remove the file. Removing the file first leaves any approval GreenLight already holds there in
place.

## Caches and the TTL trade-off

The scan keeps, between scans in one process (a warm Lambda or a `--loop` daemon), each repo's
eligibility source, one cache per repo, `eligibility` and `minimum_role`, kept for
`PYTORCH_GREENLIGHT_MERGE_RULES_TTL_SECONDS` (600 s). A transient failure (a GitHub 5xx, a network
error or timeout) serves the last eligibility snapshot for at most three TTLs; a broken or missing
source, or a rate limit, fails the repo's scan at once. `--pr` rechecks share the caches but never
the tick memory.

So a change to `merge_rules.yaml`, or to who holds a write_permission repo's minimum role, reaches
the scan within the TTL rather than on the next tick. The record job's eligibility check reads the
rules, or the author's permission, live, so no new approval follows a removal. The ineligible revoke
reaches only listed PRs, and the listing keeps cohort authors only, so an author who leaves the
cohort keeps an approval already given until it is dismissed by hand.

## Modules

- `repo_config.py`: reads and judges a repo's config file (`Settings`), for the scan, the verdict,
  the markers and `check-config`.
- `repo_scan.py`: one repo's scan: its settings, the live checks, its eligibility cache, then a
  review or a drain.
- `review.py`: the scan's safety work (listing, state read, revert guard, ineligible revoke);
  `review_finish.py`: its optional work (fingerprint fan-out, dispatch, label pass, refusals) and
  its error aggregation.
- `drain.py`: the `off` drain; `scan_memory.py` keeps its progress between ticks.
- `snapshot_cache.py`: the TTL cache each repo's eligibility source is read through.
- `writers.py`: `write_permission` eligibility: the holders of the repo's minimum role as one rule
  for the scan, and one author's role for the verdict.
- `author_eligibility.py`: the verdict's live eligibility check (`has_eligible_author`), from either
  source.
