# TD label dataset

Builds the (unit, test file) -> failed dataset for pytorch's target determination (TD)
from HUD ClickHouse (read-only, every value a bound parameter) and a pytorch clone
(read-only git), for one window. Standard library only, plus `torchci.td.llm`.

```bash
python -m torchci.td.labels --start 2026-11-03 --stop 2026-11-06 \
  --pytorch ~/pytorch --out labels/
```

ClickHouse access comes from `CLICKHOUSE_ENDPOINT`, `CLICKHOUSE_USERNAME` and
`CLICKHOUSE_PASSWORD`, as for the rest of `torchci`. The clone needs a local `main`;
each month's test list is extracted from it into `<out>/cache/`.

## Output

- `units.jsonl.gz`: one unit per line, every line with the same keys: `unit_id`, `kind`,
  `time` (unix seconds), `sha`, `pr_number`, `candidates_month` (main) or `candidates`
  (PR units), `positives`, `observed`, `single`, `confirmed`, `workflow`,
  `build_environment`, `test_config`, `propensity`, `train_ok`. A key that does not
  apply to a kind is `null`.
- `candidates.jsonl.gz`: each month's test list (`month`, `commit`, `tests`).
- `manifest.json`: units and positives per kind, and the rows and files dropped and why.

## Units

- `main` (`c:<sha>`): pushes to main that landed one commit. A file is positive when it
  newly broke at that push: it failed in a failed job of a config; at the previous push
  every shard of that config reported and the file failed in no job; it fails again in
  that config at the first of the next 3 pushes where the config reported. Every other
  test of the month's list is negative. `train_ok` is false when more than 50 files
  newly failed at the push (an infra-wide break).
- `pr_td_off` (`p:<pr>:<head>:<workflow>:<env>:<config>`): a PR-specific failure in a job
  where TD did not cut the tests (macOS, XPU and ONNX builds,
  `torchci.td.llm.replay.cut_applied`). Positives are the unit's PR-specific failing
  files; `observed` is the files that ran in the config's jobs at that head (null when no
  test report was found), so negatives are `observed` minus `positives`. A unit exists
  only where such a failure exists. A file that failed without writing a test report (a
  crash) is a positive that may be missing from `observed`. `confirmed` lists the files
  that failed in at least 2 jobs or heads.

PR-specific means E2 (`torchci.td.llm.events`) lists the (PR, file) failure: it did not
also fail on main within 48 hours.

Month candidates add the C++ test files (`cpp/...`) TD ranked that month, from the E2
rows and the TD-off rows read for the window: `discover_tests.py` lists none without a
build. The offline TD analysis's `pr_on` units and its filter on commits the clone
holds (`diff_ok`) are not ported: training filters on its features.

## Limits

- PR labels go through E2, which reads the TD metric back 365 days
  (`queries.PR_LOOK_BACK_DAYS`): their negatives come from test reports, which are kept
  about a year. A window starting before that builds main units only and sets
  `pr_kinds_skipped` in the manifest, so keep each window's output. Main units rebuild
  for as long as pushes, jobs and failed tests are kept.
- End the window at least 3 days ago: metric rows land up to about 28 hours late, test
  reports appear once the whole workflow completes, and a main failure needs later
  pushes to be confirmed.
- Test reports are read from `default.test_run_summary` (from 2026-10-05), falling back
  to `tests.all_test_runs` for jobs it lacks.
