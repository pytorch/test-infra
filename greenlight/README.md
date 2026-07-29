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

PyTorch Green Light has two entry points. `plan` fetches the open PRs from a fixed
set of trusted authors in `pytorch/pytorch` (a live, read-only GitHub call that
requires `PYTORCH_GREENLIGHT_GITHUB_TOKEN`) and logs them; `act` logs only.
Selection and scoring, the code-review step, and approve/revoke are planned — see
the Current status section below.

```bash
just run plan                     # run the plan phase once, then exit
just run act                      # run the act phase once, then exit
just plan                         # convenience alias for `just run plan`
just act                          # convenience alias for `just run act`
just run plan --loop              # run the plan phase forever as a daemon
just run act --loop --interval 30 # daemon, 30s between iterations
```

The `plan` examples require `PYTORCH_GREENLIGHT_GITHUB_TOKEN` to be set; without it
`plan` exits non-zero.

Configuration is read from the environment via `PYTORCH_GREENLIGHT_*` variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PYTORCH_GREENLIGHT_GITHUB_TOKEN` | unset | GitHub token for read-only PR access; required by `plan` |
| `PYTORCH_GREENLIGHT_INTERVAL_SECONDS` | `60` | Seconds between iterations in `--loop` mode |
| `PYTORCH_GREENLIGHT_LOG_LEVEL` | `INFO` | Logging level (e.g. `INFO`, `DEBUG`) |
| `PYTORCH_GREENLIGHT_LOCK_PATH` | unset | Lock file path guarding against concurrent runs (unset = no lock) |
| `PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS` | `600` | Per-iteration hard cap on runtime (`0` = disabled) |
| `PYTORCH_GREENLIGHT_BACKOFF_BASE_SECONDS` | `1` | Base backoff after a failed iteration (daemon mode) |
| `PYTORCH_GREENLIGHT_BACKOFF_MAX_SECONDS` | `60` | Maximum backoff between retries (daemon mode) |

`PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS` (default `600`, `0` = disabled) bounds every
iteration in both one-shot and `--loop` mode. In `--loop` mode, SIGTERM/SIGINT are
observed only between iterations, so the per-iteration timeout is what interrupts a
hung run.

## Current status

Works today: the CLI runs a phase once (cron-like) or as a `--loop` daemon, with a
single-instance lock, a per-iteration soft timeout plus a hard watchdog, backoff on
failure, and clean signal shutdown — all built and tested. `plan` fetches the open
PRs from a fixed set of trusted authors in `pytorch/pytorch` (read-only GitHub) and
logs them; it requires `PYTORCH_GREENLIGHT_GITHUB_TOKEN`. `act` logs only.

Not built yet: gating, scoring, and the review decision in `plan`; the code-review
agent (a separate component); `act`'s approve/revoke; and wiring the `eval_hash`
land-guard into `plan`/`act` and persisting to `misc.greenlight_pr_state`. The
hash and fingerprint code (`pr_hash`, `github_client`) and the ClickHouse table both
exist, but they are not connected to the service.

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
  cli.py           # CLI parsing (plan/act subcommands), dispatch, exit codes
  runner.py        # run_forever(): resilient daemon loop; execute_once(): one-shot phase run
  plan.py          # fetch open PRs from trusted authors in pytorch/pytorch and log them; raises on failure
  act.py           # logs only (stub); raises on failure
  github_client.py # read-only GitHub PR access + PR fingerprint builder
  pr_hash.py       # eval_hash land-guard: deterministic PR fingerprint hash
  config.py        # PYTORCH_GREENLIGHT_* environment configuration
  guards.py        # single-instance lock + per-iteration SIGALRM timeout + hard watchdog
  log.py           # logging setup
  exit_codes.py    # process exit codes
tests/             # unit tests mirroring the modules above
```
