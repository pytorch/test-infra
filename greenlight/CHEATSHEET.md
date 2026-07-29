# PyTorch Green Light cheatsheet

Command reference for the `greenlight` service. Run every command from the `greenlight/`
directory. `just` is the front-end for every workflow — run `just` or
`just --list` to see all recipes.

PyTorch Green Light runs one iteration of a phase and exits (cron-like), or loops as a daemon
with `--loop`. It has two phases:

- `plan` — fetch the open PRs from a fixed set of trusted authors in `pytorch/pytorch`
  and log them (needs `PYTORCH_GREENLIGHT_GITHUB_TOKEN`).
- `act` — logs only (stub); planned: turn review decisions into approvals/revocations.

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
just plan            # one plan iteration, then exit
just act             # one act iteration, then exit
just run <args>      # pass arbitrary args to the greenlight CLI (plan/act are shortcuts)
```

`just act` logs `INFO greenlight.act applying approval decisions` and exits `0`.
`just plan` logs `INFO greenlight.plan planning investigations`, then queries GitHub
for the trusted authors' open PRs and logs each one; without
`PYTORCH_GREENLIGHT_GITHUB_TOKEN` it raises and exits `1`. Log lines are
`TIMESTAMP LEVEL logger message`. Exit codes: `0` ok, `1` the phase raised, `3`
another instance holds the lock (`2` is an argparse usage error).

`act` is a stub (logs only); `plan` fetches and logs the trusted authors' open PRs
but does not yet gate, score, or decide reviews. Selection and scoring and
approve/revoke are planned.

Daemon mode loops the phase on an interval:

```bash
just plan --loop                 # loop forever, default 60s interval
just plan --loop --interval 30   # loop every 30s
just act --loop                  # same for act
```

The daemon logs `INFO greenlight.runner daemon starting with interval N seconds`,
runs each iteration, and on SIGTERM/SIGINT stops cleanly after the current
iteration (`INFO greenlight.runner daemon stopped`, exit `0`). Signals are observed
only between iterations.

Config comes from `PYTORCH_GREENLIGHT_*` env vars; CLI flags `--interval`, `--log-level`, and
`--lock-path` override them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PYTORCH_GREENLIGHT_GITHUB_TOKEN` | unset | GitHub token for read-only PR access; required by `plan` |
| `PYTORCH_GREENLIGHT_INTERVAL_SECONDS` | `60` | Seconds between iterations in `--loop` mode |
| `PYTORCH_GREENLIGHT_LOG_LEVEL` | `INFO` | Logging level (`INFO`, `DEBUG`, ...) |
| `PYTORCH_GREENLIGHT_LOCK_PATH` | unset | Single-instance lock file (unset = no lock) |
| `PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS` | `600` | Per-iteration hard timeout (`0` = disabled) |
| `PYTORCH_GREENLIGHT_BACKOFF_BASE_SECONDS` | `1` | Base backoff after a failed iteration (daemon) |
| `PYTORCH_GREENLIGHT_BACKOFF_MAX_SECONDS` | `60` | Max backoff between retries (daemon) |

Raise verbosity with `--log-level DEBUG` (or `PYTORCH_GREENLIGHT_LOG_LEVEL=DEBUG`); DEBUG also
logs the resolved `Config`.

## Simulate a run

The intended end-to-end flow is: `plan` (select, gate, and score PRs; decide which
need review) -> the code-review agent (the review step) -> `act` (approve or revoke
based on the review decisions).

Reality today: `plan` fetches and logs the trusted authors' open PRs (a live,
read-only GitHub call needing `PYTORCH_GREENLIGHT_GITHUB_TOKEN`) but does not yet
gate, score, or decide reviews; the code-review agent step is not implemented; and
`act` logs only. So a local run exercises the two entry points and their wiring, not
the real selection, review, or approve/revoke behavior.

What you can run today (DEBUG to watch the flow):

```bash
just plan --log-level DEBUG   # fetch + log trusted authors' open PRs (needs token; no gating/scoring yet)
# code-review agent / review step — not implemented yet
just act --log-level DEBUG    # logs only (stub)
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

## Database migrations

The `misc.greenlight_pr_state` schema is managed by the ClickHouse migration
runner in `tools/clickhouse-migrations/`. Unlike every other command here, run
these from the **repository root**, not `greenlight/`.

The greenlight service does not yet read or write `misc.greenlight_pr_state`; the
table and the `eval_hash` land-guard exist ahead of the wiring that will connect them.

`migrate.py` reads credentials from the environment and does not load `.env`
itself, so pass one with uv (a `.env` is git-ignored, so it is safe to create):

```bash
cp tools/clickhouse-migrations/.env.example .env   # then fill in host + credentials
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLICKHOUSE_HOST` | — | Bare host or full URL (`https://` and `:8443` are stripped); `CLICKHOUSE_ENDPOINT` is an accepted alias |
| `CLICKHOUSE_USERNAME` | — | Required |
| `CLICKHOUSE_PASSWORD` | — | Required |
| `CLICKHOUSE_PORT` | `8443` | Connection port |

```bash
uv run --env-file .env tools/clickhouse-migrations/migrate.py status   # list applied vs pending (a read-only cred is enough)
uv run --env-file .env tools/clickhouse-migrations/migrate.py apply    # apply pending migrations (needs an admin/DDL cred)
uv run tools/clickhouse-migrations/migrate.py apply --dry-run          # print the SQL only; makes no DB connection
```

- **Credentials precedence:** `uv run --env-file` does *not* override `CLICKHOUSE_*`
  variables already set in your shell — ambient values win silently. If your
  environment already exports them (e.g. for pytorch-hud / clickhouse-mcp), unset
  them first so your `.env` is used, e.g. `env -u CLICKHOUSE_HOST -u CLICKHOUSE_USERNAME
  -u CLICKHOUSE_PASSWORD -u CLICKHOUSE_PORT uv run --env-file .env
  tools/clickhouse-migrations/migrate.py apply`. This matters most for `apply` (it
  writes DDL) — confirm the target before running it.
- Migrations are forward-only and applied in filename order (e.g.
  `0001_create_misc_greenlight_pr_state.sql`); each is recorded in the
  `misc.schema_migrations` ledger only after it succeeds. There are no down migrations.
- `apply` is a deliberate, human-run step using admin/DDL credentials. When wired,
  the greenlight service will use data-only credentials and never run `apply`.
- The runner excludes `.clickhouse.cloud` from the proxy on its own, so no manual
  proxy bypass is needed here.

See `tools/clickhouse-migrations/README.md` for authoring new migrations.
