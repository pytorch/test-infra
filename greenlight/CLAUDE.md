# CLAUDE.md — PyTorch Green Light

This file is the canonical project guidance for any coding agent operating in `greenlight/`.

## What This Is

PyTorch Green Light is a Python 3.14 service invoked from the CLI. Its `review` phase
runs a single iteration and exits (cron-like), e.g. `just run review`. It can also run
as a long-lived daemon with `--loop`, e.g. `just run review --loop`, which repeats the
phase on an interval. The phase runs through the same one-shot and daemon execution
paths, so PyTorch Green Light can move between cron-driven and daemon deployment with no
change to phase logic.

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

- `review.run()` — scans the open PRs from a fixed set of trusted authors in
  `pytorch/pytorch` (the trusted-author set is the match rule); for each PR it computes the
  fingerprint (`eval_hash`), reads the PR's latest state from `misc.greenlight_pr_state`,
  and dispatches the reviewer workflow (`greenlight-pr-review.yml` on `pytorch/test-infra`)
  for new or changed PRs, skipping any PR untouched beyond `PYTORCH_GREENLIGHT_REVIEW_WINDOW_HOURS`
  (default 24) that has no in-flight or retry-eligible (cancelled/failed) review. Requires `PYTORCH_GREENLIGHT_GITHUB_TOKEN`
  and `CLICKHOUSE_*` read access.

Approving or rejecting a PR lives in the dispatched reviewer workflow (through `verdict`),
not in the `review` scan itself.

The `eval_hash` land-guard (`pr_hash.compute_pr_hash` /
`github_client.build_pr_fingerprint`) is computed by the `review` scan and recorded to
`misc.greenlight_pr_state` by `verdict`; only the land-time verifier that reads it back at
land time is not built yet.

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

## Comments

Default is NO comment. Add one only for a genuinely non-obvious, durable WHY. No
TODO, history, or task-narration comments.
