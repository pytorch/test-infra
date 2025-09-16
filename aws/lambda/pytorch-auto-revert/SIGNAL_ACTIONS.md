# Signal Actions Layer

This document specifies the Actions layer that consumes extracted Signals with their processing outcomes, decides what to do (restart/revert/none), executes allowed actions, and logs actions. Logging the full state of the run is handled by a separate run‑state logger module (see Interfaces).

## Overview

- Inputs (provided by integration code):
  - Run parameters: `repo_full_name`, `workflows`, `lookback_hours`, `dry_run_restart`, `dry_run_revert`.
  - A list of pairs: `List[Tuple[Signal, SignalProcOutcome]]`, where `SignalProcOutcome = Union[AutorevertPattern, RestartCommits, Ineligible]`.
- Decisions: per-signal outcome mapped to a concrete action:
  - `AutorevertPattern` → record a global revert intent for the suspected commit
  - `RestartCommits` → restart workflow(s) for specific `(workflow, commit)` pairs
  - `Ineligible` → no action
- Side effects: workflow restarts (when `dry_run_restart=False`); append-only logging of actions in ClickHouse.
- Idempotence and dedup: enforced via ClickHouse lookups before acting and logging.

## Run Context

Immutable run-scoped metadata shared by all actions in the same run:

- `ts`: DateTime captured at run start; identical across all rows inserted for the run
- `repo_full_name`: e.g., `pytorch/pytorch`
- `workflows`: list of workflow display names
- `lookback_hours`: window used for extraction
- `dry_run_restart`: bool (controls whether restarts are executed)
- `dry_run_revert`: bool (controls whether reverts are executed - currently always record-only)

## Action Semantics

- `revert` (record-only):
  - Scope: global per `commit_sha` across all workflows and signals
  - Dedup logic:
    - If `dry_run_revert=True`: skip if ANY revert (dry-run or not) exists for the same `repo` and `commit_sha`
    - If `dry_run_revert=False`: skip only if a non-dry-run revert exists

- `restart` (execute + log):
  - Scope: per `(workflow, commit_sha)` pair
  - Dedup logic:
    - If `dry_run_restart=True`: skip if ANY restart (dry-run or not) exists for the pair
    - If `dry_run_restart=False`: apply caps (max 2) and pacing (15 min) based on non-dry-run restarts only
  - No extra GitHub-side "already restarted" guard; rely on ClickHouse logs for dedup/caps

- `none`:
  - Not logged in `autorevert_events_v2` (only actions taken are logged)

- Multiple signals targeting same workflow/commit are coalesced in-memory, then deduped again via ClickHouse checks.
- Shadow mode (e.g., `dry_run_restart=False, dry_run_revert=True`):
  - Execute restarts normally but log reverts as dry-run only
  - Useful for testing the system's decision-making without performing actual reverts

## ClickHouse Logging

Two tables, sharing the same `ts` per CLI/lambda run.

### `autorevert_events_v2`

- Purpose: record actions taken during a run & dedup/cap against prior actions
- Columns:
  - `ts` DateTime — run timestamp
  - `repo` LowCardinality(String)
  - `action` Enum8('none' = 0, 'restart' = 1, 'revert' = 2)
  - `commit_sha` FixedString(40)
  - `workflows` Array(String) — workflows involved in this action
    - restart: a single-element array with the target workflow
    - revert: one or more workflows whose signals contributed
  - `source_signal_keys` Array(String) — signal keys that contributed to this action
  - `dry_run` UInt8 DEFAULT 0
  - `notes` String DEFAULT '' — optional free-form metadata
- Engine and keys:
  - Partition by month: `toYYYYMM(ts)`
  - Order by: `(repo, commit_sha, action, ts)`
- Example queries the layer relies on:
  - Revert dedup: `WHERE repo=? AND action='revert' AND commit_sha=? AND dry_run=0 LIMIT 1`
  - Restart caps/pacing: `WHERE repo=? AND action='restart' AND commit_sha=? AND has(workflows, ?) AND dry_run=0 ORDER BY ts DESC LIMIT 2`

### `autorevert_state` (separate module)

- Purpose: persist the HUD-like state for the whole run for auditability
- Columns:
  - `ts` DateTime — run timestamp (matches `autorevert_events_v2.ts`)
  - `repo` LowCardinality(String)
  - `state` String — JSON-encoded model of the HUD grid and outcomes
  - `dry_run` UInt8 DEFAULT 0
  - `workflows` Array(String)
  - `lookback_hours` UInt16
  - `params` String DEFAULT '' — optional, free-form
- Engine and keys:
  - Partition by month: `toYYYYMM(ts)`
  - Order by: `(repo, ts)`

## Processing Flow

1. Create `RunContext` and capture `ts` at start (integration).
2. Provide the Actions layer with: `(run params, List[Tuple[Signal, SignalProcOutcome]])`.
3. Transform and group the list into coalesced action groups (reusable method):
   - Revert groups: `(action=revert, commit_sha, sources: List[SignalMetadata(workflow, key)])`
   - Restart groups: `(action=restart, commit_sha, workflow_target, sources: List[SignalMetadata(workflow, key)])`
4. For each group, consult `autorevert_events_v2` to enforce dedup rules:
   - Reverts:
     - If `dry_run_revert=True`: skip if ANY prior revert exists for `commit_sha`
     - If `dry_run_revert=False`: skip only if a non-dry-run revert exists
   - Restarts:
     - If `dry_run_restart=True`: skip if ANY prior restart exists for `(workflow_target, commit_sha)`
     - If `dry_run_restart=False`: skip if ≥2 non-dry-run restarts exist; skip if the latest non-dry-run restart is within 15 minutes of `ts`
5. Execute eligible actions:
   - Restart: if `dry_run_restart=False`, dispatch and capture success/failure in `notes`
   - Revert: record only (currently no execution)
6. Insert one `autorevert_events_v2` row per executed group with aggregated `workflows` and `source_signal_keys` (use respective `dry_run_restart`/`dry_run_revert` flags).
7. Separately (integration), build the full run state and call the run‑state logger to write a single `autorevert_state` row with the same `ts`.

## Interfaces

- `RunContext`: `ts`, `repo_full_name`, `workflows`, `lookback_hours`, `dry_run_restart`, `dry_run_revert`
- `SignalMetadata`: `{ workflow_name: str, key: str }`
- `SignalProcOutcome`: alias to `Union[AutorevertPattern, RestartCommits, Ineligible]`
- `ActionGroup` (coalesced):
  - Revert: `{ type: 'revert', commit_sha: str, sources: list[SignalMetadata] }`
  - Restart: `{ type: 'restart', commit_sha: str, workflow_target: str, sources: list[SignalMetadata] }`
- `SignalActionProcessor`:
  - `group_actions(pairs: list[tuple[Signal, SignalProcOutcome]]) -> list[ActionGroup]`
  - `execute(groups: list[ActionGroup], ctx: RunContext) -> list[ActionGroup]` (returns executed/logged groups)
- `ActionLogger` (ClickHouse):
  - `prior_revert_exists(repo: str, commit_sha: str, check_dry_run: bool = False) -> bool`
  - `recent_restarts(repo: str, workflow: str, commit_sha: str, limit: int = 2, check_dry_run: bool = False) -> list[datetime]`
  - `insert_event(repo, ts, action, commit_sha, workflows, source_signal_keys, dry_run, notes)`
- `RunStateLogger` (separate module):
  - Input: `RunContext` and `List[Tuple[Signal, SignalProcOutcome]]`
  - Output: inserts one row into `autorevert_state` with JSON state and run params

## State JSON Shape (Run-State Logger)

Compact, HUD-like snapshot for `autorevert_state.state`:

```json
{
  "commits": ["<sha_newest>", "<sha_older>", ...],
  "columns": [
    { "workflow": "trunk", "key": "linux-test", "outcome": "restart", "note": "..." },
    { "workflow": "pull", "key": "path::test_a", "outcome": "revert" }
  ],
  "meta": {
    "repo": "pytorch/pytorch",
    "workflows": ["trunk", "pull"],
    "lookback_hours": 24,
    "ts": "2025-08-21T12:34:56Z",
    "dry_run_restart": false,
    "dry_run_revert": false
  }
}
```

## Testing

- Unit tests for mapping outcomes to actions and for dedup rules:
  - Revert skipped when a non-dry-run `revert` exists for the commit
  - Restart cap (max 2) and 15-minute pacing per `(workflow, commit)`
  - Dry-run rows do not affect dedup decisions
  - Multiple signals producing the same targets coalesce
- Integration-style tests with faked CH client and restart service to validate compute → dedup → execute → log, and `autorevert_state` shape.
