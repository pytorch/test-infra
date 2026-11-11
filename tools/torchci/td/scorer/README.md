# TD scorer

A learned layer over pytorch's target determination (TD) heuristics, retrained daily:

- **Scorer**: each heuristic's score is calibrated into the chance a test file fails
  (isotonic fit), and the calibrated log-odds are combined with non-negative weights plus
  build-env and test-config terms and ln(cost) into p. pytorch's `run_test.py` keeps the
  files EditedByPR or PreviouslyFailedInPR scored, then fills up to the cost of TD's own
  cut by p / cost.
- **Risk score**: one number per change, r in [-1, 1] with mean 0, from the change's
  changed-file counts. It is computed and logged in the TD job; nothing uses it to size
  the cut.

The model file is published at
`https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/td-scorer.json`.

## The model contract

pytorch/pytorch `tools/testing/target_determination/scorer_model.py` (standard library
only) is the definition of the file format, its validation and how p and r are evaluated;
`scorer.py` next to it uses them in the TD job and in `run_test.py`. `model_json.py` here
writes that format and evaluates p the same way, and the daily workflow runs pytorch's
validator and evaluator on every new model before publishing it.

The build-env terms are keyed by the job base name (the job name before ` / test (`), the
key of `td_exclusions` and of `test-times.json`; it equals `BUILD_ENVIRONMENT` for most
jobs, but not for nested reusable workflows such as `dynamo-unittest / dynamo-test (3.12)`.

## Data sources

- **Heuristic scores**: the TD job's log
  (`https://ossci-raw-job-status.s3.amazonaws.com/log/<job_id>`): `Results from
  <Heuristic>` followed by `  <TestRun> (<score>)` lines, `Error in <Heuristic>`,
  `Changed files: [...]`, and TD's summed scores after `Aggregated Heuristics`. A
  class-level TestRun counts as its file's maximum. Only TD's own heuristic names enter
  the model (`HEURISTICS` in `train.py`): the log comes from the PR's code.
- **TD-on jobs**: `additional_info/td_exclusions/<run_id>/<attempt>` in the same bucket. A
  (run, build env, test config) is TD-on when TD excluded files there.
- **Outcomes**: `tests.all_test_runs` (one row per test case), joined to the job on its
  id and its run. A file failed in a PR job when it had a real failure (a failure or an
  error, not rerun-only) at its latest attempt, in a job that concluded `failure` with at
  most 20 failing files. A file that failed in any other way (rerun-only, passed at a
  later attempt of the same job, or in a job past the cap or not concluded `failure`) is
  neither a positive nor a negative, and so is a file that failed in that config on main
  that day: any real failure in a TD-scope job of a `push` or `schedule` run of
  pytorch/pytorch on `main` (a fork PR's branch named `main` does not count). The
  `expected` pseudo-file is not a test file.
- **Trunk breaks**: the saved query `td_trunk_breakages` (pairs with outcome `td_skipped`),
  `default.merges` (no `-f`; waived checks excluded) and `default.push`.
- **Test cost**: `stats/test-times.json` on generated-stats, as `run_test.py` looks it up,
  plus 24 s per file.

Training weighs each PR's positives at most 20 and its negatives at most 10,000, so a PR
CI ran many times does not outweigh the rest: one PR run's negatives weigh about 1,500
(the passing files of its TD-on jobs), and in late October 2026 the cap bound the 9% of
PRs with the most runs.

All ClickHouse queries bind their values as parameters and run with `readonly = 2`.

## Day shards

Each UTC day's TD-on PR jobs are stored once at
`s3://ossci-raw-job-status/td_scorer/rows/v2/<YYYY-MM-DD>.jsonl.gz`. A shard is written
only when absent and never overwritten, and only for days that ended at least two days
before the run, whose jobs have finished. A shard is also written only when healthy: no
fetch of a TD log or td_exclusions object failed (a 404 is a missing object, any other
error is a failure), at most 15% of its TD-on runs lack a parsable TD log, and it has
outcomes whenever it has TD-on runs. Any change to the labels, the features or the format
of a shard bumps `SHARD_FORMAT` in `store.py`, which starts a new prefix. The ClickHouse
S3 replicator does not ingest this prefix.

An unhealthy day is left out of training, the gate and the walk-forward, and is listed
in the run's output:
- **Gaps** never fail a run. A day whose TD logs are missing or unparsable is a gap, all
  of them included, and so is a day with no outcomes (its parsed logs' runs have no
  outcome rows at all) that is older than the 14 days before the run (`GATE_DAYS`). Such
  a day is also permanent when its gap is in the data, not in a fetch: more than 15% of
  its logs are 404s, or it has no outcomes. A permanent day older than the 14 days before
  the run gets a `<day>-gap-0.15` marker next to the shards (the bound is in the name and
  its counts in the content), and later runs skip it. Logs that answer but do not parse
  (on 2026-07-16 GitHub's rate-limit message was stored as the log) are never marked, so
  a parser fix or a re-upload brings the day back. To build a marked day again, delete
  its marker.
- **Other unhealthy days** are built again by the next run, and on main they fail the run
  when they are gate days: a fetch failed, building the day raised (a ClickHouse error,
  for example), or a day within the last 14 has no outcomes.

20 of the 367 days from 2025-11-06 to 2026-11-07 had more than 15% of their logs missing,
and 2025-11-22 and 23 have no outcomes.

## The data window

Training uses every healthy day from `FIRST_DATA_DAY` (`shards.py`, 2025-11-06) to 15
days before the refit day; the 14 days after that are the gate window. 2025-11-06 is the
first whole day with all three sources: `tests.all_test_runs` has rows from 2025-11-05
17:00 UTC on (a day earlier, only the runs of that evening have outcomes), while the TD
logs (seen back to 2025-10-30) and the `td_exclusions` objects already exist for its runs.
`td_trunk_breakages` only reports landings from 2026-07-13 on, so earlier days have no
counted trunk breaks. In June 2026 most `td_exclusions` objects are keyed `NoBuildEnv` /
`NoTestConfig` instead of the job's build env and test config, so that month's days pass
the health rule with about 5% of the TD-on jobs of the months around it.

**Backfill**: each refit builds the missing shards of the window newest first, writing
each healthy one as soon as it is built, and stops starting new days after
`BACKFILL_SECONDS` (3 hours, `store.py`); building a day takes about 30-60 s, and the
whole year took about 3 hours. It then trains and gates on the days it has, prints how
many days are still missing, and the next runs build them. A run that got only part way
passes or fails on its gate like any other. The refit job's 285 minutes cover the
backfill, about 25 minutes of fitting, walk-forward and holdout on one year (more on the
runner), and the upload, and end before its S3 credentials expire after 300 minutes
(`role-duration-seconds`).

## The daily workflow

`.github/workflows/td-scorer.yml`:

- **refit**: builds missing day shards (S3 on main, within the backfill budget; a pull
  request builds three days in memory and writes nothing), fits the scorer and the risk
  score on the data window, runs the walk-forward and the gate below, and writes the
  model. The job fails when the gate fails, when anything in the refit raises, when a
  gate day could not be built soundly or the holdout set is unsound on main, or when
  ClickHouse credentials are missing on main. A pull request's run trains on two days,
  too few for a walk-forward month, so its floor is not met; it only prints the report.
- **check**: validates the model with pytorch main's `scorer_model.py`, compares its p
  and r with the trainer's on a sample (max difference 1e-6), and replays the gate's cut of
  a sample of jobs with pytorch's `scorer.select_tests` (same selection required). It runs
  pytorch's code from a sparse checkout of `tools/testing` and `tools/stats`. Any
  difference that is not finite fails it. While pytorch main has no `scorer_model.py` or
  no `scorer.py`, the check is skipped and counts as not validated.
- **publish** (main only, no secrets, and only after the check validated the model):
  pushes `stats/td-scorer.json` to generated-stats.

## The gate

Both checks below must pass for a model to publish. Every comparison is at TD's own cost
per job: the scorer's cut may cost no more than TD's own include list, which the gate
rebuilds from the TD log's aggregated scores the way `run_test.py` takes the top 25%.

1. **Holdout** (the fair check): the `td-holdout-unstable` runs of 2026-08-30..09-18 ran
   every test file with TD off, so their failures are not biased toward what TD chose to
   run. For each PR-specific failure there (not broken on main that day, counted once per
   PR, config and file, and left out when a must-run heuristic scored the file, as in the
   walk-forward), the gate asks whether TD's include list and the scorer's cut held the
   file. The scorer must catch at least as many as TD. The holdout set is built once
   and stored write-once at
   `s3://ossci-raw-job-status/td_scorer/holdout/<SHARD_FORMAT>.jsonl.gz` (pull requests
   build it in memory), and only when it is sound: no fetch failed, at most 15% of the heads with a
   successful TD job lack its log, and at least 40 failures (`MIN_HOLDOUT_EVENTS`); an
   unsound set fails the gate, and the run on main. Caveats: it is small, about 54
   failures in 32 PRs, so a difference of a few failures is noise; its test jobs always
   conclude `success`, so a failure there is not required to have failed its job. Its
   PRs are left out of training.
2. **Floor**, over the walk-forward: for each calendar month that starts at least a
   month after the first healthy day, through the day before the refit, a scorer and a
   risk score are fitted on every healthy day before that month, without the month's PRs
   and the holdout PRs. Each month scores the PRs whose first TD run is in it, with their
   failures at the first failing head, minus the files a must-run heuristic scored there,
   which both cuts run. Each PR with failures counts its recall for each side: of the
   scorer's cut, and of TD's include list as the gate rebuilds it. Pooled over the months,
   the scorer must reach 60% of TD (`FLOOR_RATIO`, `--floor-ratio`), over at least 30 PRs
   with failures (`MIN_FLOOR_PRS`). Before the scorer is published, the jobs ran TD's own
   cut, so TD's recall is about 1 and the measure favours TD. After it, failures are only
   observed in files the published scorer ran, so the months from then on favour the
   scorer, and the holdout stays the only unbiased check.

The shipped model is fitted on every healthy day up to 15 days before the refit. Reported
only, per month and in total: the units, the event recall, the counted trunk landings and
how many the scorer caught (TD none, by construction), and the risk score's AUC on the
months' PR heads; and the holdout counts (failures, PRs, TD and scorer catches, mean files
per job), the walk-forward's wall time and the run's peak memory.

## Turning the scorer off

Set `"enabled": false` in `stats/td-scorer.json` on the generated-stats branch. pytorch's
TD job then uses TD's own cut, and the publish job never replaces a file whose `enabled` is
not true. Setting it back to true (or deleting the file) lets the next daily run publish
again.

## Running locally

From `tools/` with `pip install -e torchci`, and `CLICKHOUSE_ENDPOINT`,
`CLICKHOUSE_USERNAME` and `CLICKHOUSE_PASSWORD` set:

```bash
python -m torchci.td.scorer refit --day 2026-11-10 --train-days 2 --gate-days 1 \
  --cache-dir /tmp/td-shards --out /tmp/td-scorer.json --sample /tmp/sample.json \
  --report-only
python -m torchci.td.scorer check-pytorch --model /tmp/td-scorer.json \
  --sample /tmp/sample.json --pytorch-root ../../pytorch
```

`--cache-dir` keeps day shards in a local directory instead of S3; `check-pytorch` reads
the sample `refit --sample` writes.
