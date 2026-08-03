# PyTorch Green Light

A Python service that runs a periodic iteration from the CLI — a one-shot
(cron-like) run by default, or a long-lived daemon with `--loop`.

## Requirements

- **mise** — the only manual prerequisite. See <https://mise.jdx.dev>.

Everything else (Python 3.14, uv, just, and the non-Python linters) is provided
by mise; `just setup` then installs the Python tools (ruff, mypy, pytest, yamllint).

## Setup

```bash
mise trust      # trust greenlight/mise.toml on first use
mise install    # install python 3.14, uv, just, and all tools
just setup      # uv sync -> create .venv with deps
```

## Usage

PyTorch Green Light has two subcommands. `review` scans the open PRs from a fixed set of
trusted authors in `pytorch/pytorch` and, for each one, computes its fingerprint
(`eval_hash`), reads the PR's latest recorded state from ClickHouse
`misc.greenlight_pr_state`, and dispatches the reviewer workflow
(`greenlight-pr-review.yml` on `pytorch/test-infra`) for PRs that are new or changed since
their last review. A PR whose `updated_at` is older than
`PYTORCH_GREENLIGHT_REVIEW_WINDOW_HOURS` (default 24) is skipped without fingerprinting unless
it has an in-flight or retry-eligible (cancelled/failed) review to re-check. An in-flight review — one marked
`AI_REVIEW_STARTED` — is left alone until the `--timeout-minutes` re-dispatch window elapses.
`verdict` records a single
PR-review verdict and acts on the PR (see below).

```bash
just run review                      # scan + dispatch once, then exit
just review                          # convenience alias for `just run review`
just run review --loop               # scan + dispatch forever as a daemon
just run review --loop --interval 30 # daemon, 30s between iterations
just run review --pr 123             # restrict the scan to PR #123
just run review --max 5              # cap this iteration at 5 dispatches
just run review --ref my-branch      # dispatch the reviewer workflow at this test-infra ref (default main)
just run review --timeout-minutes 60 # re-dispatch an in-flight review after 60 min (default 45)
```

`review` requires `PYTORCH_GREENLIGHT_GITHUB_TOKEN`, and any scan that finds at least one
trusted-author PR also reads ClickHouse, so the `CLICKHOUSE_*` credentials must be set in
practice; without the token `review` exits non-zero.

The default `--timeout-minutes` is 45, above the reviewer workflow's own ~37-40 min
budget, so with the default the scanner lets a running review finish (or time out and
record a verdict) before it re-dispatches, rather than cancelling and restarting one that
is still running. Lower `--timeout-minutes` in the deployment if you need a stuck review
reclaimed sooner.

### Recording a verdict

A privileged CI job records a review verdict with `verdict`. It runs once (never a
daemon): it emits a gzipped single-line JSON row (whose `reason` must be a canonical
`ALLOWED_REASONS` code) that the record workflow uploads to
`s3://gha-artifacts/greenlight_pr_state/`, where the clickhouse-replicator-s3 path ingests
it into `misc.greenlight_pr_state` — the command never writes ClickHouse directly. Then,
for `LAND`/`NO_LAND`, it acts on the PR (`LAND` approves; `NO_LAND` dismisses greenlight's
own prior approval and comments). `CANCELLED` and `FAILED` markers only emit the row. The
model's message is defanged before it is posted to GitHub, while the full message is stored
verbatim in the emitted row.

```bash
just run verdict --pr 123 --head-sha "$SHA" --verdict-file verdict.json \
  --eval-hash "$EVAL_HASH" --bot-login 'greenlight-app[bot]'   # LAND/NO_LAND
just run verdict --pr 123 --head-sha "$SHA" --status CANCELLED  # marker: emit row only
just run verdict --pr 123 --head-sha "$SHA" --verdict-file verdict.json \
  --eval-hash "$EVAL_HASH" --dry-run                            # offline; logs only
```

The command writes the gzipped row to `/tmp/greenlight-verdict-row.json.gz` and its
bucket-relative key to `/tmp/greenlight-verdict-key.txt`; the workflow `aws s3 cp`s the
former to the latter. There is no direct ClickHouse write, so no `CLICKHOUSE_*` credentials
are needed here; `verdict` needs `PYTORCH_GREENLIGHT_GITHUB_TOKEN` to post `LAND`/`NO_LAND`,
and `--dry-run` needs nothing. `--bot-login` (the greenlight GitHub App's `<slug>[bot]`
account) is required for `NO_LAND`.

Configuration is read from the environment via `PYTORCH_GREENLIGHT_*` variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PYTORCH_GREENLIGHT_GITHUB_TOKEN` | unset | GitHub token used by `review` and `verdict`; `review` needs Actions: write (`workflow_dispatch`) on `pytorch/test-infra`, PR read on `pytorch/pytorch`, and org Members: read (`read:org`) to expand `merge_rules.yaml` team refs |
| `PYTORCH_GREENLIGHT_INTERVAL_SECONDS` | `60` | Seconds between iterations in `--loop` mode |
| `PYTORCH_GREENLIGHT_LOG_LEVEL` | `INFO` | Logging level (e.g. `INFO`, `DEBUG`) |
| `PYTORCH_GREENLIGHT_LOCK_PATH` | unset | Lock file path guarding against concurrent runs (unset = no lock) |
| `PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS` | `600` | Per-iteration hard cap on runtime (`0` = disabled) |
| `PYTORCH_GREENLIGHT_BACKOFF_BASE_SECONDS` | `1` | Base backoff after a failed iteration (daemon mode) |
| `PYTORCH_GREENLIGHT_BACKOFF_MAX_SECONDS` | `60` | Maximum backoff between retries (daemon mode) |
| `PYTORCH_GREENLIGHT_MERGE_RULES_TTL_SECONDS` | `600` | How long a resolved `merge_rules.yaml` authorized-login set is cached before refetch |
| `PYTORCH_GREENLIGHT_REVIEW_WINDOW_HOURS` | `24` | `review` skips a PR whose `updated_at` is older than this many hours, unless it has an in-flight or retry-eligible (cancelled/failed) review to re-check |

`review` additionally reads ClickHouse — any scan that finds at least one trusted-author
PR looks up `misc.greenlight_pr_state` — via the standard `CLICKHOUSE_*` connection
variables (`CLICKHOUSE_HOST` or its `CLICKHOUSE_ENDPOINT` alias, `CLICKHOUSE_USERNAME`,
`CLICKHOUSE_PASSWORD`, and `CLICKHOUSE_PORT`, default `8443`).

`PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS` (default `600`, `0` = disabled) bounds every
iteration in both one-shot and `--loop` mode. In `--loop` mode, SIGTERM/SIGINT are
observed only between iterations, so the per-iteration timeout is what interrupts a
hung run.

## Current status

Works today: the CLI runs the `review` phase once (cron-like) or as a `--loop` daemon,
with a single-instance lock, a per-iteration soft timeout plus a hard watchdog, backoff
on failure, and clean signal shutdown — all built and tested. `review` scans the open PRs
from a fixed set of trusted authors in `pytorch/pytorch`, computes each PR's fingerprint
(`eval_hash`), reads the PR's latest recorded state from `misc.greenlight_pr_state`, and
dispatches the reviewer workflow (`greenlight-pr-review.yml` on `pytorch/test-infra`) for
PRs that are new or changed. PRs whose `updated_at` is older than the review window
(`PYTORCH_GREENLIGHT_REVIEW_WINDOW_HOURS`, default 24) are skipped without fingerprinting
unless a review is in-flight or retry-eligible (cancelled/failed). An `AI_REVIEW_STARTED` marker is treated as an
in-flight review and left alone until the `--timeout-minutes` window (default 45) elapses.
`review` requires `PYTORCH_GREENLIGHT_GITHUB_TOKEN`, and any scan with at least one PR reads
ClickHouse (`CLICKHOUSE_*`).

Also works: the reviewer workflow's `announce_start` job emits the `AI_REVIEW_STARTED`
marker at run start; the `verdict` subcommand emits a PR-review verdict row (with the
passed-in `eval_hash` verbatim) for the record workflow to upload to
`s3://gha-artifacts/greenlight_pr_state/`, where the clickhouse-replicator-s3 path ingests
it into `misc.greenlight_pr_state`; for LAND/NO_LAND it also acts on the PR — approve, or
dismiss greenlight's prior approval and comment. `verdict` is a one-shot call for a
privileged CI job and never writes ClickHouse directly. The service reads ClickHouse via
`clickhouse_client.connect()` for both the review scan and its other SELECTs.

`misc.greenlight_pr_state` is append-only-equivalent: it keeps its `SharedReplacingMergeTree`
engine, but no verdict emit is ever collapsed because the sort key
`(repo, pr_number, run_id, emit_id)` ends in a per-emit UUID (`emit_id`) that no two rows
share. greenlight picks the authoritative row per PR at read time by highest `run_id`, then
latest `version` (`state.read_latest_states`). Ordering by `run_id` before `version` is
race-proof — a superseded slower dispatch that finishes with a later `version` still loses to
the newer dispatch's higher `run_id`. Each emitted row carries those `run_id` and `emit_id`
columns, added by a single in-place `ALTER` (`greenlight/sql/004`) that also extends the sort
key — no new table, backfill, or `EXCHANGE`. At go-live that DDL and the
clickhouse-replicator-s3 Lambda adapter must land together, since a schema skew between them
drops rows.

Not built yet: only the land-time verifier — the pytorchbot side that reads
`misc.greenlight_pr_state` back at land time. The review-side scan, fingerprint, state
read, and dispatch are all wired; nothing consumes the recorded state at land time yet.

When wired, the land-time verifier must look up stored state by `(repo, pr_number)`
— the ledger's `ORDER BY` key — never by `eval_hash` alone: the fingerprint omits
repo and PR number, so a hash-only lookup would let one PR's approval replay onto a
different PR. The writer (greenlight) and the verifier (pytorchbot) run the identical
`pr_hash` / `build_pr_fingerprint` code and upgrade hash schemes together.

The fingerprint also covers only comments authored by `pytorch/pytorch`'s
merge-authorized set — every `approved_by` login in `.github/merge_rules.yaml`, with team
refs expanded to members (see `merge_authz`). The land-time verifier MUST resolve that same
set the same way — via `merge_authz.resolve_authorized_logins`, which lowercases every login
and unions *all* `merge_rules.yaml` entries — and MUST NOT reuse pytorch's `trymerge.py`
authorization check, which is case-sensitive and scoped to the rules whose file patterns
match a single PR. A divergent set computes a different digest and refuses every land. A
login entering or leaving the set re-fingerprints only the PRs where that login has
commented.

## Development

```bash
just lint        # ruff, markdownlint, shellcheck, shfmt, yamllint, taplo
just lint-fix    # auto-fix what the linters can
just typecheck   # mypy (strict)
just test        # pytest + coverage (>=97%)
```

All gates must pass before a change is complete.

## Layout

```text
src/greenlight/
  __init__.py      # package exports (Config, __version__)
  __main__.py      # `python -m greenlight` entry point
  cli.py           # CLI parsing (review + verdict subcommands), dispatch, exit codes
  runner.py        # run_forever(): resilient daemon loop; execute_once(): one-shot phase run
  review.py        # scan trusted-author PRs: fingerprint, read state, dispatch reviewer workflow for new/changed; raises on failure
  state.py         # read a PR's latest recorded state from misc.greenlight_pr_state
  decision.py      # decide which scanned PRs need a (re-)dispatch (new/changed vs. in-flight AI_REVIEW_STARTED)
  dispatch.py      # trigger the reviewer workflow on pytorch/test-infra via workflow_dispatch
  verdict.py       # one-shot: emit a verdict row for S3->replicator, then approve/dismiss/comment on the PR
  github_client.py # GitHub PR access: read PR list/fingerprint + post verdict actions
  clickhouse_client.py # ClickHouse connection helper for the service's read (SELECT) queries
  pr_hash.py       # eval_hash land-guard: deterministic PR fingerprint hash
  config.py        # PYTORCH_GREENLIGHT_* environment configuration
  constants.py     # shared constants for the review scan/dispatch flow
  guards.py        # single-instance lock + per-iteration SIGALRM timeout + hard watchdog
  log.py           # logging setup
  exit_codes.py    # process exit codes
tests/             # unit tests mirroring the modules above
```
