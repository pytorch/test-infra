# flake-test-fail-autorevert

Standalone CLI that reads pytorch-auto-revert's **already-published** decisions
from ClickHouse and writes a CSV. It does not re-run any analysis: it only reads
stored decisions.

One CSV row is produced per commit (landing on `main` within the requested
range) that either:

- triggered an autorevert on a **test** regression, or
- had test signals that autorevert flagged as **flaky**.

Only test-level signals are reported (signal keys containing `::`); job-level
signals are excluded.

## Output columns

- `commit_sha` — full 40-char sha
- `commit_url` — `https://github.com/{repo}/commit/{commit_sha}`
- `commit_time` — landing time on `main` (`YYYY-MM-DD HH:MM:SS`, UTC)
- `regressions` — semicolon-joined test signal keys that triggered an autorevert
  on this commit, each annotated with the advisor verdict when one exists, e.g.
  `test_fake_pg.py::test_split_group_rank_3 (related, 0.99)`. Empty if none.
- `flaky_signals` — semicolon-joined test signal keys autorevert flagged flaky on
  this commit. Empty if none.

Rows are sorted by `commit_time` ascending.

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
  (N commits, M with regressions, K with flaky) are printed on completion.

## Notes on the flaky scan

Flaky signals are read from the `misc.autorevert_state` JSON snapshots. Several
independent autorevert configurations run concurrently, each publishing its own
snapshot stream distinguished by its `workflows` set. The flaky query scans **all**
autorevert state snapshots in the range (exhaustive — every snapshot, deduped in
Python), so the `flaky_signals` column reflects every (commit, test) pair autorevert
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

A signal can appear in **both** `regressions` and `flaky_signals` for the same commit;
the two columns answer independent questions (did it trigger an autorevert vs. did
autorevert observe both a pass and a fail on that commit).

DNS to the ClickHouse cloud host flaps intermittently, so each query is retried
with exponential backoff on connection/name-resolution errors; SQL errors fail
fast.
