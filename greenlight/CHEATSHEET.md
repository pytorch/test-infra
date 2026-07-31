# PyTorch Green Light cheatsheet

Command reference for the `greenlight` service. Run every command from the `greenlight/`
directory. `just` is the front-end for every workflow — run `just` or
`just --list` to see all recipes.

PyTorch Green Light runs one iteration of its `review` phase and exits (cron-like), or
loops as a daemon with `--loop`. It also has a one-shot `verdict` subcommand:

- `review` — fetch the open PRs from a fixed set of trusted authors in `pytorch/pytorch`
  and log them (needs `PYTORCH_GREENLIGHT_GITHUB_TOKEN`).
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
just review          # one review iteration, then exit
just run <args>      # pass arbitrary args to the greenlight CLI (review is a shortcut)
```

`just review` logs `INFO greenlight.review reviewing open PRs from trusted authors in
pytorch/pytorch`, then queries GitHub for the trusted authors' open PRs and logs each
one; without `PYTORCH_GREENLIGHT_GITHUB_TOKEN` it raises and exits `1`. Log lines are
`TIMESTAMP LEVEL logger message`. Exit codes: `0` ok, `1` the phase raised, `3`
another instance holds the lock (`2` is an argparse usage error).

`review` fetches and logs the trusted authors' open PRs but does not yet score risk or
decide reviews. Risk-scoring, the AI code-review workflow, and approve/reject are planned.

Daemon mode loops the phase on an interval:

```bash
just review --loop               # loop forever, default 60s interval
just review --loop --interval 30 # loop every 30s
```

The daemon logs `INFO greenlight.runner daemon starting with interval N seconds`,
runs each iteration, and on SIGTERM/SIGINT stops cleanly after the current
iteration (`INFO greenlight.runner daemon stopped`, exit `0`). Signals are observed
only between iterations.

Config comes from `PYTORCH_GREENLIGHT_*` env vars; CLI flags `--interval`, `--log-level`, and
`--lock-path` override them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PYTORCH_GREENLIGHT_GITHUB_TOKEN` | unset | GitHub token for read-only PR access; required by `review` |
| `PYTORCH_GREENLIGHT_INTERVAL_SECONDS` | `60` | Seconds between iterations in `--loop` mode |
| `PYTORCH_GREENLIGHT_LOG_LEVEL` | `INFO` | Logging level (`INFO`, `DEBUG`, ...) |
| `PYTORCH_GREENLIGHT_LOCK_PATH` | unset | Single-instance lock file (unset = no lock) |
| `PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS` | `600` | Per-iteration hard timeout (`0` = disabled) |
| `PYTORCH_GREENLIGHT_BACKOFF_BASE_SECONDS` | `1` | Base backoff after a failed iteration (daemon) |
| `PYTORCH_GREENLIGHT_BACKOFF_MAX_SECONDS` | `60` | Max backoff between retries (daemon) |

Raise verbosity with `--log-level DEBUG` (or `PYTORCH_GREENLIGHT_LOG_LEVEL=DEBUG`); DEBUG also
logs the resolved `Config`.

## Simulate a run

The intended end-to-end flow is: `review` (fetch PRs, score risk, decide which need
review) -> the AI code-review workflow (which approves or rejects).

Reality today: `review` fetches and logs the trusted authors' open PRs (a live,
read-only GitHub call needing `PYTORCH_GREENLIGHT_GITHUB_TOKEN`) but does not yet score
risk or decide reviews; the AI code-review workflow is not implemented. So a local run
exercises the entry point and its wiring, not the real scoring, review, or
approve/reject behavior.

What you can run today (DEBUG to watch the flow):

```bash
just review --log-level DEBUG   # fetch + log trusted authors' open PRs (needs token; no risk-scoring yet)
# risk-scoring — not implemented yet
# AI code-review workflow (approve/reject) — separate component, not implemented yet
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

The `verdict` subcommand does NOT write ClickHouse directly: it emits a gzipped JSON row
that the record workflow uploads to `s3://gha-artifacts/greenlight_pr_state/`, and the
clickhouse-replicator-s3 path ingests it into the table. greenlight keeps ClickHouse READ
access for the service's SELECTs via `clickhouse_client.connect()`, which reads the standard
`CLICKHOUSE_*` connection variables (`CLICKHOUSE_HOST` or its `CLICKHOUSE_ENDPOINT` alias,
`CLICKHOUSE_USERNAME`, `CLICKHOUSE_PASSWORD`, and `CLICKHOUSE_PORT` default `8443`). The
review-side fingerprint computation and the land-time verifier that reads this table back
are not built yet.
