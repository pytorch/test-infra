# radar

A Python service that runs a periodic iteration from the CLI — a one-shot
(cron-like) run by default, or a long-lived daemon with `--loop`.

## Requirements

- **mise** — the only manual prerequisite. See <https://mise.jdx.dev>.

Everything else (Python 3.14, uv, just, and the non-Python linters) is provided
by mise; `just setup` then installs the Python tools (ruff, mypy, pytest, yamllint).

## Setup

```bash
mise trust      # trust radar/mise.toml on first use
mise install    # install python 3.14, uv, just, and all tools
just setup      # uv sync -> create .venv with deps
```

## Usage

radar has two entry points: `plan` selects, gates, and scores open PRs and
decides which need a code review; `act` turns review decisions into PR approvals
or revocations.

```bash
just run plan                     # run the plan phase once, then exit
just run act                      # run the act phase once, then exit
just plan                         # convenience alias for `just run plan`
just act                          # convenience alias for `just run act`
just run plan --loop              # run the plan phase forever as a daemon
just run act --loop --interval 30 # daemon, 30s between iterations
```

Configuration is read from the environment via `RADAR_*` variables:

| Variable | Purpose |
| --- | --- |
| `RADAR_INTERVAL_SECONDS` | Seconds between iterations in `--loop` mode |
| `RADAR_LOG_LEVEL` | Logging level (e.g. `INFO`, `DEBUG`) |
| `RADAR_LOCK_PATH` | Lock file path guarding against concurrent runs |
| `RADAR_MAX_RUNTIME_SECONDS` | Hard cap on a single iteration's runtime |
| `RADAR_BACKOFF_BASE_SECONDS` | Base backoff after a failed iteration (daemon mode) |
| `RADAR_BACKOFF_MAX_SECONDS` | Maximum backoff between retries (daemon mode) |

For daemon mode (`--loop`), set `RADAR_MAX_RUNTIME_SECONDS` (default `0` = disabled)
to bound each iteration: SIGTERM/SIGINT are observed only between iterations, so the
per-iteration timeout is what interrupts a hung run.

## Development

```bash
just lint        # ruff, markdownlint, shellcheck, shfmt, yamllint, taplo
just lint-fix    # auto-fix what the linters can
just typecheck   # mypy (strict)
just test        # pytest + coverage (>=90%)
```

All gates must pass before a change is complete.

## Layout

```text
src/radar/
  cli.py       # CLI parsing (plan/act subcommands) + one-shot vs --loop dispatch
  runner.py    # run_forever(): resilient daemon loop; execute_once(): one-shot phase run
  plan.py      # select, gate, and score PRs, decide which need review; raises on failure
  act.py       # turn review decisions into PR approvals or revocations; raises on failure
  config.py    # RADAR_* environment configuration
  log.py       # logging setup
  guards.py    # single-instance lock file + per-iteration runtime cap
tests/         # unit tests mirroring the modules above
```
