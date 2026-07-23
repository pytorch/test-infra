# CLAUDE.md — radar

This file is the canonical project guidance for any coding agent operating in `radar/`.

## What This Is

radar is a Python 3.14 service invoked from the CLI. It exposes two phases —
`plan` and `act` — each of which runs a single iteration and
exits (cron-like), e.g. `just run plan`. Either phase can also run as a long-lived
daemon with `--loop`, e.g. `just run plan --loop`, which repeats that phase on an
interval. Both phases share the same one-shot and daemon execution paths, so radar
can move between cron-driven and daemon deployment with no change to phase logic.

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

radar has two units of work, one per phase — the placeholder seams where new logic
goes:

- `plan.run()` — select, gate, and score open PRs and decide which need a code review.
- `act.run()` — turn review decisions into PR approvals or revocations.

Add new logic inside the relevant phase's `run()`, which **must keep raising on
failure** (it does not catch). The CLI selects a phase (`radar plan` / `radar act`)
and runs it through one of two execution paths, so a phase can move between
cron-driven and daemon deployment with no change to its logic:

- One-shot / cron mode (`execute_once`) lets the exception propagate to a non-zero
  exit, so cron alerts on failure.
- Daemon mode (`run_forever`, via `--loop`) catches the exception, logs it, backs
  off, and continues the loop.

Keep each phase's `run()` propagating failures: do not swallow failures on the
one-shot path, and do not let the daemon die on a single failed iteration.

Both paths run under the single-instance lock (`RADAR_LOCK_PATH`). In `--loop` mode,
SIGTERM/SIGINT stop the daemon only between iterations, so a long-running or hung
iteration is bounded only by `RADAR_MAX_RUNTIME_SECONDS` (the per-iteration timeout,
disabled by default).

## Comments

Default is NO comment. Add one only for a genuinely non-obvious, durable WHY. No
TODO, history, or task-narration comments.
