# CLAUDE.md — radar

This file is the canonical project guidance for any coding agent operating in `radar/`.

## What This Is

radar is a Python 3.14 service invoked from the CLI to run a single periodic
iteration (cron-like): `just run` does one iteration and exits. It is designed to
also run as a long-lived daemon with `just run --loop`, which repeats the same
iteration on an interval. Both paths share one unit of work, so radar can move
between cron-driven and daemon deployment with no change to the core logic.

## Tooling

- **mise** provisions every tool (python 3.14, uv, just, shellcheck, shfmt,
  taplo, markdownlint-cli2, node). `mise install` bootstraps everything.
- **uv** owns the Python venv and dependencies, and runs the Python tools (ruff,
  mypy, pytest, yamllint).
- **just** is the front-end task runner — the entry point for every workflow.

Always go through mise / uv / just. Never call `pip`, `poetry`, or `conda` directly.

## Before Declaring Work Complete (MANDATORY)

```bash
just lint        # ruff, markdownlint, shellcheck, shfmt, yamllint, taplo
just typecheck   # mypy (strict)
just test        # pytest + coverage (>=90%)
```

All three must pass with zero errors. If any fail, fix before finishing — do not
defer; they block CI.

## Code Organization

- src-layout: runtime code in `src/radar/`; tests mirror the modules under `tests/`.
- No file over 400 lines. Split by responsibility before it grows past the limit.
- One clear responsibility per module.
- Single source of truth: define each value and type exactly once, import elsewhere.
- No `print()` — use the logging module.

## The Service Seam

The unit of work lives in `core.perform_iteration()` — the placeholder seam where
new logic goes. `core.run_once()` wraps it with logging and **must keep propagating
failures** (it does not catch). Keep this seam intact:

- One-shot / cron mode lets the exception propagate to a non-zero exit, so cron
  alerts on failure.
- Daemon mode (`run_forever`) catches the exception, logs it, backs off, and
  continues the loop.

Add new logic inside `perform_iteration()`; keep `run_once()` propagating failures.
Do not swallow failures on the one-shot path, and do not let the daemon die on a
single failed iteration.

In `--loop` mode, SIGTERM/SIGINT stop the daemon only between iterations, so a
long-running or hung iteration is bounded only by `RADAR_MAX_RUNTIME_SECONDS` (the
per-iteration timeout, disabled by default).

## Comments

Default is NO comment. Add one only for a genuinely non-obvious, durable WHY. No
TODO, history, or task-narration comments.
