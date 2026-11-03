# Tests for the test_cost view

`fortesting/000005-test-cost-view.sql` (test_cost_mv) splits each test job's
wall time among test files two ways, occupancy and test-time ratio. These
tests run its committed SQL on literal inputs: `test_cost_harness.py` swaps
its sources (`default.workflow_job`, `ci.runs`, `ci.tests`, `ci.owners`) for
literal tables and its window for fixed dates, then runs it as a SELECT on the
service `migrate.py` uses (`CLICKHOUSE_ENDPOINT`, `CLICKHOUSE_USERNAME`,
`CLICKHOUSE_PASSWORD`). The queries read no real table and write nothing, so a
read-only user is enough; without `CLICKHOUSE_ENDPOINT` the tests are skipped.

```
cd clickhouse_db_schema/tests
python3 -m unittest -v
```

| File | Checks |
| --- | --- |
| `test_test_cost_toy.py` | Timelines small enough for pencil and paper, each drawn in its docstring with the arithmetic: overlapping, touching and identical spans; reports with many tests; gaps inside and between reports; skipped runs; C++ modules and xdist reports; multi-file reports; clipping to the job; which jobs count; owners. |
| `test_test_cost_realistic.py` | CI-sized shards (setup, serial phase, a pool of 3, stragglers, skips, C++) and one real job (`fixtures/`) against `reference.py`, a separate brute-force statement of the same definitions, to 1e-6 s per row and column. |
| `check_test_cost.py` | Read-only sanity checks of the filled table after a refresh or backfill: freshness, both methods' totals agree, totals match job wall time in `default.workflow_job`, row bounds, rows for test jobs without reports, executed time against `ci.runs`, owner drift, parallelism and overhead. `python3 check_test_cost.py --days 2026-11-01:2026-11-03` |

Every test also checks the invariants: both methods add up to the counted
jobs' wall time, held time adds up to busy time (the union of spans), and no
row holds more than it is charged.
