# Signal Actions Layer

This document specifies the Actions layer that consumes extracted Signals with their processing outcomes, decides what to do (restart/revert/none), executes allowed actions, and logs actions. Logging the full state of the run is handled by a separate run‑state logger module (see Interfaces).

## Overview

- Inputs (provided by integration code):
  - Run parameters: `repo_full_name`, `workflows`, `lookback_hours`, `dry_run`.
  - A list of pairs: `List[Tuple[Signal, SignalProcOutcome]]`, where `SignalProcOutcome = Union[AutorevertPattern, RestartCommits, Ineligible]`.
- Decisions: per-signal outcome mapped to a concrete action:
  - `AutorevertPattern` → record a global revert intent for the suspected commit
  - `RestartCommits` → restart workflow(s) for specific `(workflow, commit)` pairs
  - `Ineligible` → no action
- Side effects: workflow restarts (non-dry-run only); append-only logging of actions in ClickHouse.
- Idempotence and dedup: enforced via ClickHouse lookups before acting and logging.

## Run Context

Immutable run-scoped metadata shared by all actions in the same run:

- `ts`: DateTime captured at run start; identical across all rows inserted for the run
- `repo_full_name`: e.g., `pytorch/pytorch`
- `workflows`: list of workflow display names
- `lookback_hours`: window used for extraction
- `dry_run`: bool

## Action Semantics

- `revert` (record-only):
  - Scope: global per `commit_sha` across all workflows and signals
  - Dedup: if a non-dry-run `revert` exists for the same `repo` and `commit_sha`, do not log another

- `restart` (execute + log):
  - Scope: per `(workflow, commit_sha)` pair
  - Caps: up to 2 non-dry-run restarts total for the pair
  - Pacing: skip if the most recent non-dry-run restart was within 15 minutes before `ts`
  - No extra GitHub-side “already restarted” guard; rely on ClickHouse logs for dedup/caps

- `none`:
  - Not logged in `autorevert_events_v2` (only actions taken are logged)

- Multiple signals targeting same workflow/commit are coalesced in-memory, then deduped again via ClickHouse checks.
- Dry-run behavior:
  - Simulate restarts (no dispatch), log actions with `dry_run=1`
  - Dry-run rows do not count toward caps/pacing or revert dedup criteria

## ClickHouse Logging

Two tables, sharing the same `ts` per CLI/lambda run.

### `autorevert_events_v2`

- Purpose: record actions taken during a run & dedup/cap against prior actions
- Notable columns:
  - `ts` DateTime — run timestamp
  - `workflows` Array(String) — workflows involved in this action
    - restart: a single-element array with the target workflow
    - revert: one or more workflows whose signals contributed
  - `source_signal_keys` Array(String) — signal keys that contributed to this action
  - `notes` String DEFAULT '' — optional free-form metadata

### `autorevert_state` (separate module)

- Purpose: persist the HUD-like state for the whole run for auditability
- Notable columns:
  - `ts` DateTime — run timestamp (matches `autorevert_events_v2.ts`)
  - `state` String — JSON-encoded model of the HUD grid and outcomes
  - `params` String DEFAULT '' — optional, free-form

## Processing Flow

1. Create `RunContext` and capture `ts` at start (integration).
2. Provide the Actions layer with: `(run params, List[Tuple[Signal, SignalProcOutcome]])`.
3. Transform and group the list into coalesced action groups (reusable method):
   - Revert groups: `(action=revert, commit_sha, sources: List[SignalMetadata(workflow, key)])`
   - Restart groups: `(action=restart, commit_sha, workflow_target, sources: List[SignalMetadata(workflow, key)])`
4. For each group, consult `autorevert_events_v2` (non-dry-run rows) to enforce dedup rules:
   - Reverts: skip if any prior recorded `revert` exists for `commit_sha`
   - Restarts: skip if ≥2 prior restarts exist for `(workflow_target, commit_sha)`; skip if the latest is within 15 minutes of `ts`
5. Execute eligible actions:
   - Restart: if not `dry_run`, dispatch and capture success/failure in `notes`
   - Revert: record only
6. Insert one `autorevert_events_v2` row per executed group with aggregated `workflows` and `source_signal_keys` (dry-run rows use `dry_run=1`).
7. Separately (integration), build the full run state and call the run‑state logger to write a single `autorevert_state` row with the same `ts`.
