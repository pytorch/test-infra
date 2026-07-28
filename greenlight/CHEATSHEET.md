# PyTorch Green Light cheatsheet

Command reference for the `greenlight` service. Run every command from the `greenlight/`
directory. `just` is the front-end for every workflow — run `just` or
`just --list` to see all recipes.

PyTorch Green Light runs one iteration of a phase and exits (cron-like), or loops as a daemon
with `--loop`. It has two phases:

- `plan` — select, gate, and score open PRs and decide which need a code review.
- `act` — turn review decisions into PR approvals / revocations.

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

`just plan` logs `INFO greenlight.plan planning investigations`; `just act` logs
`INFO greenlight.act applying approval decisions`. Log lines are
`TIMESTAMP LEVEL logger message`. Exit codes: `0` ok, `1` the phase raised, `3`
another instance holds the lock (`2` is an argparse usage error).

Both phases are currently stubs — they only log. Real selection/scoring and
approve/revoke logic lands later.

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
| `PYTORCH_GREENLIGHT_INTERVAL_SECONDS` | `60` | Seconds between iterations in `--loop` mode |
| `PYTORCH_GREENLIGHT_LOG_LEVEL` | `INFO` | Logging level (`INFO`, `DEBUG`, ...) |
| `PYTORCH_GREENLIGHT_LOCK_PATH` | unset | Single-instance lock file (unset = no lock) |
| `PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS` | `0` | Per-iteration hard timeout (`0` = disabled) |
| `PYTORCH_GREENLIGHT_BACKOFF_BASE_SECONDS` | `1` | Base backoff after a failed iteration (daemon) |
| `PYTORCH_GREENLIGHT_BACKOFF_MAX_SECONDS` | `60` | Max backoff between retries (daemon) |

Raise verbosity with `--log-level DEBUG` (or `PYTORCH_GREENLIGHT_LOG_LEVEL=DEBUG`); DEBUG also
logs the resolved `Config`.

## Simulate a run

The intended end-to-end flow is: `plan` (select, gate, and score PRs; decide
which need review) -> the code-review agent (the review step) -> `act` (approve
or revoke based on the review decisions).

Reality today: the code-review agent step is not implemented yet, and `plan` /
`act` are stubs that only log. So a local simulation just exercises the two entry
points and their wiring end to end — the real selection, review, and
approve/revoke behavior lands later.

What you can run today (DEBUG to watch the flow):

```bash
just plan --log-level DEBUG   # select/gate/score PRs, decide reviews (stub: logs only)
# code-review agent / review step — not implemented yet
just act --log-level DEBUG    # turn review decisions into approvals/revocations (stub: logs only)
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
- `just typecheck` prints `Success: no issues found in 17 source files`.
- `just test` prints e.g. `74 passed` and `Required test coverage of 97.0%
  reached. Total coverage: 99.19%`; it fails if coverage drops below 97%. Writes
  `.coverage` and `coverage.json`.

## Clean

```bash
just clean   # remove build/test artifacts and the venv
```

Removes `.venv`, `.pytest_cache`, `.ruff_cache`, `.mypy_cache`, `.coverage`,
`coverage.json`, `htmlcov`, `dist`, `build`, `*.egg-info`, and all `__pycache__`
directories. Re-run `just setup` afterwards to recreate `.venv`.
