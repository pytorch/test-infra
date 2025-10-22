# Signal Extraction Layer

This document specifies the extraction layer that converts raw CI data (workflows/jobs/tests) into Signal objects used by the Signal logic (`signal.py`).

## Overview

Two parallel tracks produce Signals:
- Test‑track Signals: per‑test identities (file + test name) across commits.
- Non‑test Signals: normalized job base names across commits (grouping shards).

Extraction runs in two phases:
- Phase A (jobs fetch): fetch recent commits and all workflow jobs (including restarts and retries) for target workflows.
- Phase B (test details fetch): select relevant jobs for the test‑track in Python and batch query test artifacts for just those jobs.

The output is a list of `Signal` instances, each with commits (newest → older) and time‑ordered `SignalEvent`s per commit.

## Principles

- Pure data mapping: no pattern logic; just construct Signals from source rows.
- Prefer simple, batched queries aligned to ClickHouse primary keys.
- Emit multiple events per commit when meaningful (different runs, retries, shards).
- Reuse existing types and helpers where possible (`CommitJobs`, `JobResult`, `normalize_job_name`).
- Keep the module self‑contained and easy to unit‑test.

## Inputs and Windowing

- Workflows of interest: e.g., `['trunk', 'pull', 'rocm-mi300', ...]` (configurable).
- Time window: 16–32h (configurable). Window is short to keep flakiness assumptions stable and long enough to include restarts.
- Commits considered: pushes to `refs/heads/main` within the window (deduplicated per head_sha).

## Phase A — Jobs Fetch (single query)

Fetch all workflow jobs (original, retries, and restarts) for the commits in the window.

- Include both original runs and restarts (re‑runs via the UI or API).
- Join to pushes to scope to recent main commits and order newest → older.
- Select minimal fields used by the extractor:
  - commit/run/job identity: `head_sha, workflow_name, id AS job_id, run_id (aka wf_run_id), run_attempt`
  - names/time: `name, started_at, created_at, status, conclusion`
  - classification shortcut: `tupleElement(torchci_classification_kg,'rule') AS rule`

Notes
- This preserves all runs (original + restarts) and per‑run attempts (`run_attempt`).
- Job retries typically show up as separate job rows; names may include `Attempt #2` and have later `started_at`.

## Phase B — Test Details Fetch (batched, from `default.test_run_s3`)

Decide in Python which jobs belong to the test‑track (e.g., `rule IN ('pytest failure','Python unittest failure')`. For those (job_id, run_id[, run_attempt]) triples, fetch per‑test rows directly from `default.test_run_s3` — this table contains one row per testcase, including successful ones (failure_count=0, error_count=0).

Why `test_run_s3` only?
- We need per‑test identities to build per‑test Signals; `default.test_run_s3` has them. Summary is optional and redundant for this layer.
- Performance remains good by filtering on `job_id IN (...)` (first PK column) and grouping; limit to the time window implicitly via the selected job set from Phase A.

Job selection for test track:
- Step 1: find normalized job base names that exhibited a test‑related classification in any commit within the window.
- Step 2: include ALL jobs across ALL commits whose normalized base is in that set (original runs, restarts; any run_id/attempt) so we can observe successes or pendings for the same test on other commits.

Optimized batched test_run_s3 query (for N job_ids):

```
SELECT job_id, workflow_id, workflow_run_attempt, file, classname, name,
       max(failure_count > 0) AS failing,
       max(error_count  > 0) AS errored,
       max(rerun_count  > 0) AS rerun_seen,
       count() AS rows
FROM default.test_run_s3
WHERE job_id IN {job_ids:Array(Int64)}
GROUP BY job_id, workflow_id, workflow_run_attempt, file, classname, name
```

Notes
- Use `job_id IN (...)` to leverage the PK prefix `(job_id, name, classname, invoking_file, file)`.
- We keep `workflow_run_attempt` to distinguish attempts within the same workflow run.

## Mapping to Signals

### Common conventions
- Commits are ordered newest → older using the push timestamp (`push_dedup.ts`).
- Each Signal carries `workflow_name` and a stable `key`:
  - Test‑track: `key = file + '::' + name` (optionally include `classname`).
  - Non‑test: `key = normalize_job_name(job_name)` (reuse `CommitJobs.normalize_job_name`).
- Each commit holds a list of `SignalEvent`s (time‑ordered by `started_at`).
  Ordering: dicts in Python 3.7+ preserve insertion order. Phase A inserts commit keys in push‑timestamp DESC order, so iterating the mapping yields newest→older commits without extra sorting.

### Test‑track semantics
- Source of truth for SUCCESS/FAILURE is `default.test_run_s3` per test id.
- When a test row exists for an attempt:
  - Emit at most one FAILURE if any failed runs exist; at most one SUCCESS if any successful runs exist.
- When no test rows exist for an attempt and any grouped job for that attempt is pending → emit PENDING.
- Otherwise (no test rows and not pending) → no event for that attempt.

### Job‑track semantics (non‑test)
- Build per normalized job base across commits; aggregate shards by `(wf_run_id, run_attempt)`.
- Event mapping per attempt uses aggregated job meta with test‑failure filtering:
  - FAILURE only when the attempt had non‑test failures (e.g. infra‑related).
  - PENDING when the attempt is still running.
  - SUCCESS otherwise, including when failures are exclusively test‑caused (these are handled by test‑track).
- Cancelled attempts are treated as missing (no event).
- Emit a job‑track Signal only when at least one attempt/commit shows a non‑test (infra) failure within the window.

Event naming (for debuggability):
- Consistent key=value format: `wf=<workflow> kind=<test|job> id=<test_id|job_base> run=<wf_run_id> attempt=<run_attempt>`
- Examples:
  - Test event: `wf=trunk kind=test id=inductor/test_foo.py::test_bar run=1744 attempt=1`
  - Job event:  `wf=trunk kind=job  id=linux-jammy-cuda12.8-py3.10-gcc11 / test run=1744 attempt=2`

### Test‑track mapping
- Build a per‑commit map `test_id -> list[SignalEvent]` by combining all relevant jobs and shards:
  - For each (wf_run_id, run_attempt, job_base_name) group in the commit, consult `test_run_s3` rows (if any) for each candidate `test_id`:
    - If `test_run_s3` rows exist for this `test_id` → status should reflect the found test verdict.
    - If no `test_run_s3` rows exist and the group is still running (some jobs pending) → status = PENDING.
    - Else (no rows and group completed) → missing/unknown (no event emitted).
  - Event boundaries (naturally arise from grouping):
    - Separate events for distinct workflow runs (different `wf_run_id`) on the same commit (regardless of how they were triggered).
    - Within the same run, separate events for retries via `run_attempt` (name hints like "Attempt #2" are not relied upon).

### Non‑test mapping
- Similar to test‑track but grouping is coarser (by normalized job base name):
- For each (run_id, run_attempt, job_base_name) group in the commit
  - Within each group compute event status:
    - FAILURE if any row concluded failure.
    - SUCCESS if all rows concluded success.
    - PENDING otherwise (some rows pending, none failed).
  - Emit one event per group. The Signal model supports multiple events per commit.
  - Results include Signals for (wf, job_base_name) that have at least one FAILURE across commits.
  - Determine status for each event:
    - FAILURE if `conclusion_kg = 'failure'` or `conclusion='failure'` with `status='completed'`.
    - SUCCESS if `conclusion='success'` with `status='completed'`.
    - PENDING if `status != 'completed'` or `conclusion=''` (keep‑going/pending).
  - Event boundaries (naturally arise from grouping):
    - Separate events for distinct workflow runs on the same commit (different `run_id`; trigger type is irrelevant).
    - Separate events for retries using `run_attempt` within the same run (no string parsing of job names).
    - Separate events for different normalized job base names.

Example (same commit & workflow):

- wf1 has: `jobX_(shard1, attempt1)`, `jobX_(shard1, attempt2)`, `jobX_(shard2, attempt1)`
- wf2 (retry) has: `jobX_(shard1, attempt1)`

Aggregation by normalized base `jobX`:
- event1: group (wf1, attempt1) → rows: `[wf1:jobX_(shard1, attempt1), wf1:jobX_(shard2, attempt1)]`
- event2: group (wf1, attempt2) → rows: `[wf1:jobX_(shard1, attempt2)]`
- event3: group (wf2, attempt1) → rows: `[wf2:jobX_(shard1, attempt1)]`

## Module Structure

Create `pytorch_auto_revert/signal_extraction.py` with:
- `class SignalExtractor` (entry point)
  - `extract(workflow_names: list[str], hours: int) -> list[Signal]`
  - Internals:
    - `_fetch_commits_and_jobs(...) -> list[Commit]` (see data structures below)
    - `_select_test_track_job_ids(commits) -> (job_ids: List[int], bases_to_track: Set[JobBaseNameKey])`
    - `_fetch_tests_for_jobs(job_ids) -> List[TestRow]` (s3 only)
    - `_build_test_signals(commits, test_rows, bases_to_track) -> list[Signal]`
    - `_build_job_signals(commits) -> list[Signal]`
- Keep logic small and pure; avoid side effects.

Notes
- Reuse `normalize_job_name` from `CommitJobs` for non‑test keys.
- For minimal coupling, do not import the existing autorevert pattern logic here.
- Prefer dataclass‑like simple structures for intermediate maps (dicts/tuples).

### Indexing & Data Structures

- Strongly-typed ids for clarity (type-checker only), like:
  - `WfRunId = NewType('WfRunId', int)`
  - `RunAttempt = NewType('RunAttempt', int)`
  These are used in the code for readability and to reduce keying mistakes.

## Implementation Plan

1) Add `signal_extraction.py` with `SignalExtractor` shell and clear method stubs. Keep types simple.
2) Implement Phase A query in a helper (reuse CHCliFactory). Unit test: query builder emits expected SQL filters.
3) Implement selectors for test‑track pairs (Python filter on `rule`).
4) Implement batched Phase B queries:
   - Use `(workflow_id, job_id) IN array(tuple(...))` to leverage PK prefixes.
   - call `test_run_s3` to enumerate failing tests
5) Implement mapping to Signals for both tracks, emitting multiple events per commit as specified.
6) Add unit tests:
   - Test‑track: a) failure on one commit; b) success on another; c) unknown/gap.
   - Non‑test: separate events for main vs restart and for `Attempt #2` retries.
7) Wire optional extraction invocation from the CLI/tester layer (behind a flag) without touching Signal’s pattern logic.

## Performance Notes

- Keep the window small (16–32h) and deduplicate commits via push timestamps.
- Limit the batched pairs size; chunk when necessary.
- Align filters with primary keys:  `job_id` for `test_run_s3`.
- Avoid scanning all of `workflow_job` by joining to recent pushes and filtering repo/branches.

## Open Questions

- Exact classification list for “test failure” track (start with `pytest failure`, `Python unittest failure`).
- Whether to include tests that succeeded but were present (for stronger success evidence) vs only failing tests.
  - A: if a test failure is observed on any commit, that test status is extracted from all commits (success/failure/pending).
- How to surface shard boundaries for test‑track Signals (usually we just OR across shards at status level).
  - A: for test track shard boundaries are irrelevant:
    - when test outcome was recorded, it is extracted as an Event (regardless of shard)
    - when no outcome was recorded, all shards with the job base name are considered:
      - when any shard is still running → PENDING
      - when all shards completed → no event (unknown)
- Whether to treat known infra classifications as gaps vs ignored (policy TBD).
