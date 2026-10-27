# CLAUDE.md — PyTorch Green Light

This file is the canonical project guidance for any coding agent operating in `greenlight/`.

## What This Is

PyTorch Green Light is a Python 3.13 service invoked from the CLI. Its `review` phase
runs a single iteration and exits (cron-like), e.g. `just run review`. It can also run
as a long-lived daemon with `--loop`, e.g. `just run review --loop`, which repeats the
phase on an interval. The phase runs through the same one-shot and daemon execution
paths, so PyTorch Green Light can move between cron-driven and daemon deployment with no
change to phase logic.

## Tooling

- **mise** provisions every tool (python 3.13, uv, just, shellcheck, shfmt,
  taplo, markdownlint-cli2, node). `mise install` bootstraps everything.
- **uv** owns the Python venv and dependencies, and runs the Python tools (ruff,
  mypy, pytest, yamllint).
- **just** is the front-end task runner — the entry point for every workflow.

Always go through mise / uv / just. Never call `pip`, `poetry`, or `conda` directly.

## Before Declaring Work Complete (MANDATORY)

```bash
just lint        # ruff, markdownlint, shellcheck, shfmt, yamllint, taplo
just typecheck   # mypy (strict)
just test        # pytest + coverage (>=97%)
```

Test coverage must stay at or above **97%** — `just test` enforces it
(`fail_under` in `pyproject.toml`) and fails below that. Raise coverage by adding
tests; never lower the threshold to make a change pass.

All three must pass with zero errors. If any fail, fix before finishing — do not
defer; they block CI.

## Code Organization

- src-layout: runtime code in `src/greenlight/`; tests mirror the modules under `tests/`.
- No file over 400 lines. Split by responsibility before it grows past the limit.
- One clear responsibility per module.
- Single source of truth: define each value and type exactly once, import elsewhere.
- No `print()` — use the logging module.

## The Service Phase

PyTorch Green Light has one unit of work — the `review` phase:

- `review.run()` — scans the open PRs from the evaluation cohort in `pytorch/pytorch`
  (`cohort.evaluation_cohort`: every `approved_by` login in `merge_rules.yaml`, team refs
  expanded, minus bots and minus greenlight itself — that cohort is the match rule); for each PR
  it computes the fingerprint (`eval_hash`), reads the PR's latest state from
  `misc.greenlight_pr_state`,
  and dispatches the reviewer workflow (`greenlight-pr-review.yml` on `pytorch/test-infra`)
  for new or changed eligible PRs, excluding reverted PRs permanently (`Reverted` label or a recorded
  `REVERTED` row: greenlight revokes its own approval, records the row, and drops the PR on every
  path — the label can be removed, the exclusion cannot, and `--pr` is skipped silently),
  dropping draft PRs outright (never fingerprinted or dispatched by the
  listing scan), and skipping any PR untouched beyond `PYTORCH_GREENLIGHT_REVIEW_WINDOW_HOURS`
  (default 24) or carrying the `Stale` label that has no in-flight or retry-eligible
  (cancelled/failed) review, and skipping — without fingerprinting or dispatching — any PR a human
  has already decided (approved by a `merge_rules.yaml` approver, bots excluded, or changes
  requested by any non-bot reviewer).
  The listing alternates per process (`pr_listing`, `scan_memory`): a full tick lists every open
  PR, on every tick until one completes, and again 15 minutes (less 30 s of tolerance;
  `FULL_TICK_INTERVAL`, `FULL_TICK_TOLERANCE`) after the start of the last full tick that completed
  (its listing and fingerprint fan-out finished without a rate-limit abort); the fast ticks between
  list the PRs updated inside the review window plus
  every open `Reverted`-labelled PR. A PR whose place in GitHub's updated order lags its
  `updated_at`, and an idle PR reverted only by its recorded row, wait for the next full tick; so
  does a PR idle longer than the review window whose review is unfinished: a failed, cancelled or
  stuck one is retried at the first full tick after its 45-minute timer, and an in-flight one whose
  fingerprint changed without bumping `updated_at` is re-dispatched there.
  Once a listing tick's fan-out finishes, the process keeps only the fingerprint results
  (`scan_memory`) that tick reused and those it fetched (a hash only when read at the listed head)
  when the listed `updated_at` was at least `FINGERPRINT_QUIET` (2 minutes) old at the clock read
  after the listing, before the fan-out; each is keyed on that `updated_at`, the listed head and the
  merge-authorized login set. A fast tick decides a PR whose key is unchanged on its kept result,
  logging the decision as `cached`, and fingerprints afresh any PR that would dispatch, so a dispatch
  never carries a cached head or hash; full ticks never reuse a result. What the key cannot see waits
  at most for the next full tick: an inline review comment edit (never bumps `updated_at`) or
  deletion (unmeasured), a conversation comment deletion that does not bump it (unmeasured; the one
  observed case bumped), an approver's login rename or account deletion, and a review dismissal that
  does not bump it. A bump that shows up only after the result was stored leaves the PR decided on
  that result until the bump becomes visible (one observed case lagged between 8 s and several
  minutes), and at most until the next full tick. Each bump, a bot's comment edit such as Dr. CI's
  included, costs a fresh fetch on every tick until one finds it at least two minutes old: at most
  two with ticks two minutes or more apart, more on a `--loop` daemon (60 s apart by default). A
  change to the approver set refetches every PR on the next tick; a `--loop` host needs a synced
  clock. `--pr` and `--force` never touch the kept results.
  Requires `PYTORCH_GREENLIGHT_GITHUB_TOKEN` (PR write, for the revocation and the `GL/*` labels),
  `BOT_LOGIN`, and `CLICKHOUSE_*` read access.

`cohort.assess_rules` answers a different question, per PR: whose evaluation carries authority. The
author must be named by a merge rule that covers every file the PR changes, a path-scoped rule only
on a PR based on `main` or on a ghstack PR; the scan and the verdict (`verdict.has_covering_rule`) run
this same check. Any other non-draft PR the scan lists is state-read and revert-guarded but never dispatched;
when it is inside the review window and not labelled `Stale`, and its latest recorded row is a
`LAND`, the scan dismisses greenlight's approval. A row is stamped **shadow** only by the verdict's
record-time downgrade, `verdict --shadow`, a local `--allow-untrusted-author` run, or the revert
guard: a `REVERTED` row, which can only deny, is non-shadow on a PR that already has a recorded row
and follows the PR's eligibility otherwise. A shadow verdict is never approved and always dismisses
any prior greenlight approval; every shadow row is filtered out of both HUD readers (Dr. CI's
render and the land-time ledger route) and triggers no Dr. CI poke. The two authorization gates
(`authz_gates`) require the `--requester` login to be in the evaluation cohort and the `--pr`
target's author to be eligible for that PR. A requester confers no authority: a review carries it
only when its PR's author passes the merge-rule check.

The scan drops ineligible PRs from the **fingerprint candidates** only after `revert_guard` and the
state read, so an ineligible PR still loses a stale approval and still gets its `REVERTED` row.

Approving or rejecting a PR lives in the dispatched reviewer workflow (through `verdict`),
not in the `review` scan itself.

The `GL/*` labels only display the ledger: never read one to decide anything. `verdict` sets
`GL/approved` / `GL/human` for a non-shadow verdict; the scan's label pass (`verdict_labels`, on
listing ticks that reach their dispatch phase without a rate limit, after `_dispatch_pending`, before the error
aggregation) supersedes and restores them, mirroring pytorch's land-time gate (`STATUS_LABELS.md`).
Label writes are best-effort and must never fail the scan or lose the verdict row; the label pass's
ClickHouse read fails the scan like the scan's other reads.

The `eval_hash` land-guard (`pr_hash.compute_pr_hash` /
`github_client.build_pr_fingerprint`) is computed by the `review` scan and recorded to
`misc.greenlight_pr_state` by `verdict`. The land-time gate lives on `pytorch/pytorch`
(`.github/scripts/greenlight_guard.py`, called from `trymerge.py`): it reads the recorded row
back over HTTP through `https://hud.pytorch.org/api/greenlight/pr_state` and gates on the stored
`head_sha`, not on `eval_hash`.

Add new logic inside `review.run()`, which **must keep raising on
failure** (it does not catch). The CLI runs the `review` phase
through one of two execution paths, so the phase can move between
cron-driven and daemon deployment with no change to its logic:

- One-shot / cron mode (`execute_once`) lets the exception propagate to a non-zero
  exit, so cron alerts on failure.
- Daemon mode (`run_forever`, via `--loop`) catches the exception, logs it, backs
  off, and continues the loop.

Keep `review.run()` propagating failures: do not swallow failures on the
one-shot path, and do not let the daemon die on a single failed iteration.

Both paths run under the single-instance lock at the configured `PYTORCH_GREENLIGHT_LOCK_PATH`.
In `--loop` mode, SIGTERM/SIGINT stop the daemon only between iterations. A hung iteration is
guarded in two layers keyed off `PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS` (default 600s): a
best-effort SIGALRM per-iteration timeout, which fires only on the main thread and cannot
interrupt blocking C calls (e.g. DNS) or off-main-thread work; and a hard watchdog that
force-exits the process a grace period later, the real backstop for hangs the soft timeout
cannot reach.

In production the scheduled scan instead deploys as the `greenlight-scan` AWS Lambda: it runs
the one-shot path with no single-instance lock and both hang-guard layers off
(`PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS=0`; the watchdog's `os._exit` is wrong under Lambda),
relying on `reserved_concurrent_executions=1` and the Lambda function timeout instead. A warm Lambda
keeps the scan's tick memory, kept fingerprints included, between invocations; a CLI one-shot always
lists in full.

## Comments

Default is NO comment. Add one only for a genuinely non-obvious, durable WHY. No
TODO, history, or task-narration comments.
