# PyTorch Green Light cheatsheet

Command reference for the `greenlight` service. Run every command from the `greenlight/`
directory. `just` is the front-end for every workflow — run `just` or
`just --list` to see all recipes.

PyTorch Green Light runs one iteration of its `review` phase and exits (cron-like), or
loops as a daemon with `--loop`. It also has a one-shot `verdict` subcommand:

- `review` — scan the open PRs from a fixed set of trusted authors in `pytorch/pytorch`;
  for each, compute its fingerprint (`eval_hash`), read its latest state from
  `misc.greenlight_pr_state`, and dispatch the reviewer workflow
  (`greenlight-pr-review.yml` on `pytorch/test-infra`) for new or changed PRs. A PR whose
  `updated_at` is older than `PYTORCH_GREENLIGHT_REVIEW_WINDOW_HOURS` (default 24) is skipped
  without fingerprinting unless a review is in-flight or retry-eligible (cancelled/failed). A PR a
  human has already decided — approved by a `merge_rules.yaml` approver (bots excluded) or with
  changes requested by any non-bot reviewer — is also skipped without fingerprinting or dispatch,
  and no state is written, so the scan resumes if that changes. Needs
  `PYTORCH_GREENLIGHT_GITHUB_TOKEN`; any scan with at least one PR also reads ClickHouse
  (`CLICKHOUSE_*`).
- `verdict` — record a PR-review verdict to `misc.greenlight_pr_state` (storing the
  passed-in `eval_hash` verbatim) and, for `LAND`/`NO_LAND`, act on the PR (approve, or
  dismiss greenlight's prior approval and comment). Runs once, never as a daemon.

## Setup

The only manual prerequisite is [mise](https://mise.jdx.dev); it provisions
everything else.

```bash
mise trust     # trust greenlight/mise.toml (first use only)
mise install   # install python 3.14, uv, just, and the non-Python linters
just setup     # uv sync -> create .venv with the Python deps
```

`mise install` provides python 3.14, uv, just, node, shellcheck, shfmt, taplo,
and markdownlint-cli2. `just setup` then installs the Python tools (ruff, mypy,
pytest, yamllint) into `.venv`.

## Run

```bash
just review                          # one scan + dispatch iteration, then exit
just run <args>                      # pass arbitrary args to the greenlight CLI (review is a shortcut)
just review --pr 123                 # scan only PR #123 (its author must be trusted)
just review --pr 123 --requester alice  # recheck PR #123 for alice (author and alice must be trusted)
just review --max 5                  # cap this iteration at 5 dispatches
just review --ref my-branch          # dispatch the reviewer workflow at this test-infra ref (default main)
just review --timeout-minutes 60     # re-dispatch an in-flight review after 60 min (default 45)
just review --pr 123 --allow-untrusted-author  # LOCAL ONLY: skip the --pr author check
```

`just review` scans the trusted authors' open PRs and, for each PR that is new or changed
since its last recorded state, dispatches the reviewer workflow
(`greenlight-pr-review.yml` on `pytorch/test-infra`); an in-flight review (marked
`AI_REVIEW_STARTED`) is left alone until the `--timeout-minutes` window elapses. Without
`PYTORCH_GREENLIGHT_GITHUB_TOKEN` it raises and exits `1`; a scan that finds any PR also
reads ClickHouse, so the `CLICKHOUSE_*` credentials must be set. Log lines are `TIMESTAMP
LEVEL logger message`. Exit codes: `0` ok, `1` the phase raised, `3` another instance
holds the lock (`2` is an argparse usage error).

The scan flags combine: `--pr N` restricts the scan to one PR, `--max N` caps how many
dispatches a single iteration issues, `--ref` sets the `pytorch/test-infra` ref the
reviewer workflow is dispatched at (default `main`), and `--timeout-minutes` (default 45)
is how long an `AI_REVIEW_STARTED` review counts as in-flight before it is re-dispatched.
That 45 is above the reviewer workflow's own ~37-40 min budget, so with the default the
scanner lets a running review finish (or time out and record a verdict) before it
re-dispatches, rather than cancelling and restarting one that is still running; lower
`--timeout-minutes` in the deployment if you need a stuck review reclaimed sooner.

`@greenlight recheck` on a `pytorch/pytorch` PR (via the separately deployed trigger) dispatches
`greenlight-review.yml` with the PR number and commenter as `--pr N --requester <login>`. The scan
is the sole authorizer: `--pr` refuses unless PR N's author is trusted, and `--requester` refuses
unless the commenter is trusted too (case-insensitive; a refusal is a clean exit 0). The local-only
`--allow-untrusted-author` skips the target-author check for iteration and is never a workflow
input. Unlike the listing scan, `--pr` ignores an existing approval and reviews anyway; if the PR
has a changes-requested review it does not review but posts a single comment that it will not
re-review while a reviewer's requested changes stand, reconsidering once the reviewer dismisses or
resolves that review. The command is not yet advertised in the PR status comment.

Daemon mode loops the phase on an interval:

```bash
just review --loop               # loop forever, default 60s interval
just review --loop --interval 30 # loop every 30s
```

The daemon logs `INFO greenlight.runner daemon starting with interval N seconds`,
runs each iteration, and on SIGTERM/SIGINT stops cleanly after the current
iteration (`INFO greenlight.runner daemon stopped`, exit `0`). Signals are observed
only between iterations.

Config comes from `PYTORCH_GREENLIGHT_*` env vars; CLI flags `--interval`, `--log-level`,
and `--lock-path` override the matching env vars, and `review` adds the scan flags `--pr`,
`--max`, `--ref`, and `--timeout-minutes`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PYTORCH_GREENLIGHT_GITHUB_TOKEN` | unset | GitHub token; `review` needs Actions: write (`workflow_dispatch`) on `pytorch/test-infra` plus PR read on `pytorch/pytorch` |
| `PYTORCH_GREENLIGHT_INTERVAL_SECONDS` | `60` | Seconds between iterations in `--loop` mode |
| `PYTORCH_GREENLIGHT_LOG_LEVEL` | `INFO` | Logging level (`INFO`, `DEBUG`, ...) |
| `PYTORCH_GREENLIGHT_LOCK_PATH` | unset | Single-instance lock file (unset = no lock) |
| `PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS` | `600` | Per-iteration hard timeout (`0` = disabled) |
| `PYTORCH_GREENLIGHT_BACKOFF_BASE_SECONDS` | `1` | Base backoff after a failed iteration (daemon) |
| `PYTORCH_GREENLIGHT_BACKOFF_MAX_SECONDS` | `60` | Max backoff between retries (daemon) |
| `PYTORCH_GREENLIGHT_REVIEW_WINDOW_HOURS` | `24` | `review` skips a PR whose `updated_at` is older than this many hours, unless a review is in-flight or retry-eligible (cancelled/failed) |

Raise verbosity with `--log-level DEBUG` (or `PYTORCH_GREENLIGHT_LOG_LEVEL=DEBUG`); DEBUG also
logs the resolved `Config`.

## Simulate a run

The end-to-end flow, per trusted-author PR:

1. `review` scans the open PRs, and for each computes its fingerprint (`eval_hash`) — unless
   the PR's `updated_at` is older than `PYTORCH_GREENLIGHT_REVIEW_WINDOW_HOURS` (default 24)
   and it has no in-flight or retry-eligible (cancelled/failed) review, or a human has already
   decided it (approved by a `merge_rules.yaml` approver with bots excluded, or changes requested
   by any non-bot reviewer), in which case it is skipped without fingerprinting.
2. It reads the PR's latest recorded state from `misc.greenlight_pr_state`.
3. If the PR is new, or its fingerprint changed since that state, and no review is
   in-flight within the `--timeout-minutes` window, it dispatches the reviewer workflow
   (`greenlight-pr-review.yml` on `pytorch/test-infra`).
4. The reviewer workflow's `announce_start` job records an `AI_REVIEW_STARTED` marker, so
   the next scan sees the review as in-flight and does not re-dispatch it.
5. The workflow reviews the PR and records its verdict through `verdict`, which emits a
   row to `s3://gha-artifacts/greenlight_pr_state/` (ingested into
   `misc.greenlight_pr_state`) and, for `LAND`/`NO_LAND`, approves or
   dismisses-and-comments on the PR.

Only the land-time verifier — the pytorchbot side that reads the recorded state back at
land time — is not built yet.

A scan is live: it makes real GitHub and ClickHouse calls and will really dispatch the
reviewer workflow. Scope a trial run with `--pr N` and cap it with `--max N`; add
`--log-level DEBUG` to watch the flow:

```bash
just review --pr 123 --max 1 --log-level DEBUG   # scan one PR, dispatch at most once
```

## Quality gates

These three are the definition-of-done gates; all must pass before a change is
complete.

```bash
just lint        # ruff (check + format), yamllint, taplo, shellcheck, shfmt, markdownlint
just typecheck   # mypy, strict
just test        # pytest + coverage
```

- `just lint` aggregates every linter's result and prints `All lint checks
  passed.` when all are clean (it exits non-zero and lists the failures if any
  fail).
- `just lint-fix` auto-fixes what it can: `ruff --fix`, `ruff format`,
  `shfmt -w`, `taplo fmt`, `markdownlint --fix`.
- `just typecheck` prints `Success: no issues found in N source files` (N = the
  number of files checked).
- `just test` prints the pass count and a coverage summary, and fails if coverage
  drops below the 97% floor (`fail_under` in `pyproject.toml`). It writes `.coverage`
  and `coverage.json` — run it for the current numbers.

## Clean

```bash
just clean   # remove build/test artifacts and the venv
```

Removes `.venv`, `.pytest_cache`, `.ruff_cache`, `.mypy_cache`, `.coverage`,
`coverage.json`, `htmlcov`, `dist`, `build`, `*.egg-info`, and all `__pycache__`
directories. Re-run `just setup` afterwards to recreate `.venv`.

## Database schema

The `misc.greenlight_pr_state` DDL lives in `greenlight/sql/`, applied by hand in
filename order — there is no automated migration tool (security does not permit
automated DDL), so @clee2000 or @huydhn apply them manually:

- `001_create_misc_greenlight_pr_state.sql` — create the table
- `002_alter_greenlight_pr_state_version_default.sql` — set the `version` DEFAULT
- `003_alter_greenlight_pr_state_add_meta.sql` — add the `_meta` column the replicator needs
- `004_*.sql` — one in-place `ALTER` that adds the `run_id` and `emit_id` columns and
  extends the sort key to `(repo, pr_number, run_id, emit_id)`, keeping the
  `SharedReplacingMergeTree` engine (no new table, backfill, or `EXCHANGE`)

The table is append-only-equivalent: the `SharedReplacingMergeTree` never collapses a row
because the sort key `(repo, pr_number, run_id, emit_id)` ends in a per-emit UUID (`emit_id`),
so every verdict emit is retained as history. greenlight selects the authoritative row per PR
at read time by highest `run_id`, then latest `version` (`state.read_latest_states`) —
race-proof, so a superseded slower dispatch that finishes with a later `version` still loses to
the newer dispatch's higher `run_id`. Applying `004` and deploying the clickhouse-replicator-s3
Lambda adapter (which gains the matching `run_id` and `emit_id` columns) is a lockstep go-live:
a schema skew between them drops rows.

The `verdict` subcommand does NOT write ClickHouse directly: it emits a gzipped JSON row
that the record workflow uploads to `s3://gha-artifacts/greenlight_pr_state/`, and the
clickhouse-replicator-s3 path ingests it into the table. greenlight reads ClickHouse via
`clickhouse_client.connect()` — the `review` scan looks up each PR's authoritative state
here, by `(repo, pr_number)` — using the standard `CLICKHOUSE_*` connection variables
(`CLICKHOUSE_HOST` or its `CLICKHOUSE_ENDPOINT` alias, `CLICKHOUSE_USERNAME`,
`CLICKHOUSE_PASSWORD`, and `CLICKHOUSE_PORT` default `8443`). The review-side fingerprint
computation is wired; only the land-time verifier that reads this table back at land time
is not built yet.
