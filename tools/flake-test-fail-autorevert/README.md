# flake-test-fail-autorevert

Standalone CLI that reads pytorch-auto-revert's **already-published** decisions
from ClickHouse and writes a CSV. It does not re-run any analysis: it only reads
stored decisions.

The CSV is **long**: one row per signal. A commit (landing on `main` within the
requested range) contributes one row for each test signal that either:

- triggered an autorevert on a **test** regression (`category = regression`), or
- was flagged **flaky** by autorevert (`category = flaky`).

Only test-level signals are reported (signal keys containing `::`); job-level
signals are excluded.

## Output columns

- `commit_sha` — full 40-char sha
- `commit_url` — `https://github.com/{repo}/commit/{commit_sha}`
- `commit_time` — landing time on `main` (`YYYY-MM-DD HH:MM:SS`, UTC)
- `category` — `regression` (this signal triggered an autorevert) or `flaky`
  (autorevert observed both a pass and a fail on this commit for this signal)
- `workflow` — the CI workflow the signal belongs to (e.g. `trunk`, `pull`,
  `inductor`, `periodic`, `slow`), or `unknown`. See attribution below.
- `signal_key` — the test signal key, `file.py::test_name`
- `advisor_verdict` — for `regression` rows, the auto-revert advisor's verdict
  (`related`, `not_related`, `infra_issue`, `garbage`, `revert`, `unsure`) when
  one exists, else empty. Always empty for `flaky` rows.
- `advisor_confidence` — for `regression` rows with a verdict, the advisor's
  confidence formatted to two decimals (e.g. `0.99`), else empty. Always empty
  for `flaky` rows.
- `premerge_status` — for `regression` rows on the `trunk` or `pull` workflow, the
  pre-merge trunk-gate status of the test on the merged commit's validated head;
  empty for all other rows. One of:
  - `RUN_SUCCEEDED` — the test ran on the pre-merge head and passed. Only ever
    emitted from a POSITIVE success-row observation, never from an empty read.
  - `RUN_FAILED` — the test ran and at least one shard failed ("merged despite
    red"). Checked before success, so a mixed pass/fail set reports as failed.
  - `NOT_RUN:force_merge` — a REAL force merge (`skip_mandatory_checks` set on the
    merge, i.e. `-f`) that bypassed the gate AND the test did not run at all. A
    force merge that still ran the test reports the test's real verdict instead —
    force_merge never masks a real outcome.
  - `NOT_RUN:skipped` — the test ran but every run was skipped.
  - `NOT_RUN:td_deselected` — the test's file ran but the test was deselected
    (test dependency / target determination).
  - `NOT_RUN:not_in_matrix` — the test's file never ran on the head (job not in
    the matrix, or no gate jobs at all on a non-force merge).
  - `NOT_RUN:no_merge_record` — no `default.merges` row resolved a pre-merge head
    for this commit, so we cannot classify it. This is the honest label for a
    ghstack **non-tip** commit (only the stack's tip PR gets a merges row keyed by
    its squashed commit), a revert, a direct push, or data predating the merges
    table. It is NOT an inference of force merge. See the coverage note below.
  - `ERROR` — a query failed after retries, or the merge timestamp was missing.

Rows are sorted by `(commit_time, category, workflow, signal_key)` ascending.

The same `(commit, signal_key)` can appear as both a `regression` row and a
`flaky` row: the two categories answer independent questions (did it trigger an
autorevert vs. did autorevert observe both a pass and a fail on that commit).

### How `workflow` is attributed

- **Flaky rows**: the workflow is exact, taken directly from the autorevert
  state snapshot the flaky signal was read from. A single `(commit, signal_key)`
  legitimately observed flaky under two workflows produces two rows.
- **Regression rows**: the reverted event stores the triggering workflows and
  the source signals as two independent arrays (a deduped set and an ordered
  list) that cannot be positionally zipped, so the workflow is resolved per
  signal with a fallback: the auto-revert advisor's workflow for that
  `(commit, signal_key)` if present, otherwise the revert event's sole workflow
  when it triggered on exactly one workflow, otherwise `unknown`.

## Environment

Reads the same connection variables as the `pytorch-auto-revert` lambda:

- `CLICKHOUSE_HOST` — host or URL (`https://` prefix and `:8443` suffix are
  stripped automatically)
- `CLICKHOUSE_PORT` — optional, defaults to `8443`
- `CLICKHOUSE_USERNAME`
- `CLICKHOUSE_PASSWORD`

Set these in the environment or in a `.env` file in the tool dir (see
`.env.example`), which is loaded on startup.

## Run

```
cd tools/flake-test-fail-autorevert
uv run flake-test-fail-autorevert --start 2026-07-01 --end 2026-07-14 \
    [--repo pytorch/pytorch] [--output out.csv]
```

`uv` auto-creates and manages a local `.venv` and installs the dependencies
declared in `pyproject.toml`, so there is no manual venv or `pip install` step.

Run the tests with:

```
uv run pytest
```

### Alternative (pip)

```
pip install -e .
flake-test-fail-autorevert --start 2026-07-01 --end 2026-07-14
# or equivalently:
python -m flake_test_fail_autorevert --start 2026-07-01 --end 2026-07-14
```

- `--start` / `--end` are dates (`YYYY-MM-DD`). The range is by commit landing
  time on `main`, and `--end` is **inclusive** (the whole end day is included):
  the effective window is `[start 00:00:00, (end + 1 day) 00:00:00)`.
- `--repo` defaults to `pytorch/pytorch`.
- `--output` defaults to
  `flake_test_fail_autorevert_<start>_<end>.csv`. The path and a one-line summary
  (`N rows across M commits: R regression, F flaky`) are printed on completion.

## Notes on `premerge_status` coverage

The pre-merge head is resolved from `default.merges`, which is keyed by the
**merge command's** commit — for a ghstack stack that is only the **tip** PR's
squashed commit. A ghstack **non-tip** commit lands its own squashed commit on
`main` but has no `default.merges` row keyed by that commit, so its pre-merge head
cannot be resolved and it is reported as `NOT_RUN:no_merge_record`. Autorevert
frequently bisects a regression to a non-tip culprit, so this is a real coverage
gap, not an edge case. There is currently no clean, reliable way to recover the
non-tip pre-merge head from ClickHouse, so `no_merge_record` is the honest label
rather than guessing. Reverts and direct pushes (no merges row) also land here.

A real `-f` force merge, by contrast, DOES write a `default.merges` row (with
`skip_mandatory_checks` set), so it resolves a head and its test status is queried
normally; `NOT_RUN:force_merge` is reported only when the gate was bypassed AND the
test genuinely did not run.

## Notes on the flaky scan

Flaky signals are read from the `misc.autorevert_state` JSON snapshots. Several
independent autorevert configurations run concurrently, each publishing its own
snapshot stream distinguished by its `workflows` set. The flaky query scans **all**
autorevert state snapshots in the range (exhaustive — every snapshot, deduped in
Python), so the `flaky` rows reflect every (workflow, commit, test) triple autorevert
flagged flaky (both a passing and a failing run on that commit) while it was in the
state window. Scanning every snapshot rather than only the day's latest is required
because commits age out of autorevert's sliding state window mid-day, so a
latest-only sample would miss flaky states that appeared earlier in the day.

The query is run once per 6-hour chunk of the padded window (~4 chunks/day) and
results are accumulated and deduped in Python. Cost note: each chunked query runs
with capped parallelism and peaks at roughly 4 GiB server-side on the busiest
observed days, taking a few seconds per chunk. Results are exhaustive (every
snapshot in range, deduped), and very large ranges scale linearly in the number of
chunks.

DNS to the ClickHouse cloud host flaps intermittently and the shared cluster can
return transient server errors (e.g. `MEMORY_LIMIT_EXCEEDED`), so each query is
retried with exponential backoff on connection, name-resolution, and transient
database errors. Genuine query bugs fail fast on the first attempt: the driver
raises a bare `DatabaseError` for server errors with the ClickHouse numeric code in
the message, so a deterministic code (syntax error, unknown table/column/function,
type mismatch, bad arguments, access denied, etc.) is detected and not retried;
unknown or transient codes default to being retried.
