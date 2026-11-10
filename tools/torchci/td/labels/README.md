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
- `manifest.json`: units and positives per kind, the rows and files dropped and why, and
  Horvitz-Thompson estimates over the explored units.

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
- `explored` (`x:<pr>:<head>:<workflow>:<env>:<config>:<call>`): files pytorch's TD
  exploration drew from what TD skipped, from the `td_exploration` metric (one row per
  run_test.py invocation, `call`, written by shard 1 before tests run), with each file's
  inclusion probability in `propensity`. Units of a (PR, head, workflow, env, config)
  come from its first attempt, every call of it. Outcomes come from that attempt's test
  jobs of the config, matched by GitHub's job name (its part before " / test (", which
  is not always the build environment, and the config): a drawn file is positive when td_test_failure_stats_v2 reports it
  as a failed explored file and the failure is PR-specific; negative when it is in the
  jobs' test reports with no failed case; otherwise not labelled (counted in the
  manifest). Files of which another part was in TD's top (`top_part`) are left out. A
  draw that picked nothing is still a unit: it counts toward the frame totals.

PR-specific means E2 (`torchci.td.llm.events`) lists the (PR, file) failure: it did not
also fail on main within 48 hours.

Month candidates add the C++ test files (`cpp/...`) TD ranked that month, from the E2
rows and the TD-off rows read for the window: `discover_tests.py` lists none without a
build. The offline TD analysis's `pr_on` units and its filter on commits the clone
holds (`diff_ok`) are not ported: training filters on its features.

## Estimates

The manifest's estimates are Horvitz-Thompson sums over the explored units, per file,
with 1 / propensity clipped at 100 (`clipped_files` counts the clipped ones; a consumer
weighting labels by 1 / propensity should clip the same way): `estimated_skipped_files`
over every drawn file, `estimated_labelled_files` over the labelled ones and
`estimated_failing_skipped_files` over the positives. The failure rate on the skipped
set is `estimated_failing_skipped_files / estimated_labelled_files`; `unlabelled_share`
is the share of drawn files without a label. They cover the frame only: skipped files
too long to explore are outside it (`out_of_frame_files`, `out_of_frame_time_share`).

## Exploration rows are untrusted

Metric rows are uploaded by code a PR can change (ciflow tag pushes run a PR's own
`run_test.py` with upload credentials). A row is used only when its repo is
pytorch/pytorch, it parses within bounds (at most 500 drawn tests, 1000 replicates,
every propensity equal to count / 1000 with 1 <= count <= 1000, finite and bounded
numbers), and `default.workflow_job` confirms the job: a pytorch/pytorch job of the same
run, head sha equal to the row's `sha`, a workflow TD runs in, and a name of shard 1 of
the row's test config. A job that wrote more than 32 calls has all its rows dropped. The PR comes from GitHub's
data (the pull_request run's PRs or the ciflow tag); the row's own `pr_number` only has
to agree. Rows that fail are counted by reason, a row that does not parse counts as
malformed, and query results are capped in size. This raises the bar for a forged row
but does not prove it came from the job it names.

## Limits

- PR labels go through E2, which reads the TD metric back 365 days
  (`queries.PR_LOOK_BACK_DAYS`): their negatives come from test reports, which are kept
  about a year. A window starting before that builds main units only and sets
  `pr_kinds_skipped` in the manifest, so keep each window's output. Main units rebuild
  for as long as pushes, jobs and failed tests are kept.
- Exploration rows are read from 3 days before to 3 days after the window. A unit
  belongs to the window its group started in: its earliest row, or the earliest job of
  its config at that head in `default.workflow_job` when that is earlier, so a re-run
  days later does not make a new unit in a later window.
- End the window at least 3 days ago: metric rows land up to about 28 hours late, test
  reports appear once the whole workflow completes, and a main failure needs later
  pushes to be confirmed.
- Test reports are read from `default.test_run_summary` (from 2026-10-05), falling back
  to `tests.all_test_runs` for jobs it lacks.
- Explored files of a shard whose TD batch failed without keep-going, or of a job that
  timed out, have no report and stay unlabelled.
