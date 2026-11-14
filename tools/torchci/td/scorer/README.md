# TD scorer

A learned layer over pytorch's target determination (TD) heuristics, retrained daily:

- **Scorer**: each heuristic's score is calibrated into the chance a test file fails
  (isotonic fit), and the calibrated log-odds are combined with non-negative weights plus
  build-env and test-config terms and ln(cost) into p. pytorch's `run_test.py` keeps the
  files EditedByPR or PreviouslyFailedInPR scored, then fills the job's budget by
  p / cost ** a: the cost of TD's own cut with a = 1, or, when the model carries a budget
  block, a share of the cost of all the job's files sized by the change's risk (see
  "The test budget"). A file's cost is its recorded seconds plus its config's start-up
  per file, k, fitted daily per build env and test config (see "Data sources"); a job
  whose config has no k keeps TD's own cut.
- **Risk score**: one number per change, r in [-1, 1] from the change's changed-file
  counts: 2F - 1, F the change's position among the training heads' raw risk (so about
  0 on average over changes like the training heads). It is computed and logged in the
  TD job, and sizes the budget when the model has a budget block.

The model is published on generated-stats
(`https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/`) as two
files from the same refit, in one commit: `td-scorer.json`, which never carries a budget
block, and `td-scorer-budget.json`, the same model with its block when the budget is on
and kept, else the same bytes. pytorch checkouts with the budget rule
(`choose_scorer_block` in `tools/testing/do_target_determination_for_s3.py`) read
`td-scorer.json` first, as the master switch: when it gives no usable model (disabled,
missing, stale or invalid), the job keeps TD's cut and no budget applies; otherwise they
use `td-scorer-budget.json` when it gives a usable model of the same version too, else
`td-scorer.json`'s model without any block. Older checkouts read only `td-scorer.json`.

## The model contract

pytorch/pytorch `tools/testing/target_determination/scorer_model.py` (standard library
only) is the definition of the file format, its validation and how p and r are evaluated;
`scorer.py` next to it uses them in the TD job and in `run_test.py`. `model_json.py` here
writes that format and evaluates p the same way, and the daily workflow runs pytorch's
validator and evaluator on every new model before publishing it.

The build-env terms are keyed by the job base name (the job name before ` / test (`), the
key of `td_exclusions` and of `test-times.json`; it equals `BUILD_ENVIRONMENT` for most
jobs, but not for nested reusable workflows such as `dynamo-unittest / dynamo-test (3.12)`.

`version` is the refit's UTC date (ISO). pytorch's TD job drops a model whose version is
more than 7 days old, more than a day ahead or not a date, and every job then keeps TD's
cut: a refit that stops publishing for a week turns the scorer off. Heuristics in trial
mode in pytorch's `HEURISTICS` never score there; `train.HEURISTICS` must leave them out
too, or `check-pytorch`'s replay disagrees with the gate and nothing publishes.

## Data sources

- **Heuristic scores**: the TD job's log
  (`https://ossci-raw-job-status.s3.amazonaws.com/log/<job_id>`): `Results from
  <Heuristic>` followed by `  <TestRun> (<score>)` lines, `Error in <Heuristic>`,
  `Changed files: [...]`, and TD's summed scores after `Aggregated Heuristics`. A
  class-level TestRun counts as its file's maximum. Only TD's own heuristic names enter
  the model (`HEURISTICS` in `train.py`): the log comes from the PR's code. Heuristics
  TD runs in trial mode are left out, as trial mode keeps them from reordering tests.
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
- **Main failures** (evaluation only, never training): new, confirmed test failures on
  main after merging, with the main push's own TD log (`main_failures.py`, whose docstring
  gives the rule and how it differs from `td_failure_ranks`). The sweep and the refit's
  report-only monitor replay cuts on them.
- **Test cost**: `stats/test-times.json` on generated-stats, as `run_test.py` looks it up,
  plus the config's start-up per file k (`start_up_seconds` in the model file). The
  training rows of a config without k use 24 s (`FALLBACK_START_UP_SECONDS`, `rows.py`);
  its p is never served, since such a job keeps TD's cut.
- **Start-up per file** (`start_up.py`): each refit first queries, one day at a time,
  every successful test job (one shard) of a TD workflow on a TD platform in the 7 days
  before the refit day: y, its `Test` step seconds (`default.workflow_job.steps`); s and
  n, the sum of its test seconds and its test files in `default.test_run_summary`
  (`file != ''`, the rows `test-times.json` averages), one row per test case: both
  tables hold some jobs' test reports twice, which would double s. Shards outside 0 < y <= 4 h, 1 <= n <= 2000, s <= 16 y are
  dropped, and so are a config's shards above its 99th percentile of n or of s, so a few
  crafted shards cannot lever the fit. Per build env and test config, y ~ c + a s + b n
  is fitted by least squares with one pass that drops residuals beyond 5 robust standard
  deviations, and k = b / a: the cut only depends on k, as the budget is TD's cut costed
  the same way. A bootstrap over head SHAs (60 resamples) gives k's 90% interval. k is
  kept when the config has at least 300 shards from 30 runs and 30 heads, a >= 0.1,
  1 <= k <= 600, 95% of the bootstrap fits are finite, the interval starts at 1 s or
  more and is at most max(k / 2, 4 s) wide; the refit prints the kept k and the rejected configs. A config
  with fewer than three distinct file counts (such as `einops`, one file) has no k. The
  refit fails when a query fails or fewer than 5 configs have k
  (`MIN_ACCEPTED_CONFIGS`); with `--report-only` it only warns about the latter.

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

A refit reads the healthy days of the last year (`WINDOW_DAYS`, 365, in `train.py`) up to
the day before the refit, from `FIRST_DATA_DAY` (`shards.py`, 2025-11-06) at the
earliest; the last 14 of them are the gate window, whose unhealthy days fail a run on
main. The shipped model is fitted on all of them but the last two, whose jobs may still
run, and the walk-forward months fall in the same year, so pytorch's older behaviour ages
out of both. 2025-11-06 is the
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

- **refit**: fits the start-up per file of each test config, builds missing day shards
  (S3 on main, within the backfill budget; a pull request builds three days in memory
  and writes nothing), fits the scorer and the risk score on the data window, runs the
  walk-forward and the gate below, and writes both model files and their samples
  (`sample.json`, `budget-sample.json`). It passes `--budget` only when
  the repository variable `TD_SCORER_BUDGET`, trimmed and lowercased, is exactly `on`
  (`model_json.budget_on`); the step summary gives the budget mode and, with a budget,
  the realised share of test-times seconds. The job fails when the gate fails, when
  anything in the refit raises, when a gate day could not be built soundly or fewer than
  5 test configs got a start-up on main, or when ClickHouse credentials are missing on
  main. A pull request's run trains on two days, too few for a walk-forward month, so its
  floor is not met; it only prints the report.
- **check**: validates the model with pytorch main's `scorer_model.py`, compares its p
  and r with the trainer's on a sample (max difference 1e-6), checks that pytorch's
  `change_features` gives the same counts on the sampled changes and that its budget
  constants (`scorer_model.py`) and build-path lists (`scorer_paths.py`) equal
  `model_json`'s and `risk.py`'s (skipped while pytorch has no budget rule and the model
  no block; any difference fails the check only when the model has a budget block, and
  is a warning otherwise, since without one the cut is the same), and replays the gate's
  cut of a sample of jobs with pytorch's `scorer.select_tests`, with their r and
  build-file count (same selection and same `budget_ms` required; for a job whose config
  has no start-up, its `NoModel` counts as TD's include list with no budget). The sample
  includes jobs served by the model with an unknown r, with build paths, and with
  must-run files over the budget when the gate days have them. It runs pytorch's code
  from a sparse checkout of `tools/testing` and `tools/stats`. Any difference that is
  not finite fails it. While pytorch main has no `scorer_model.py` or no `scorer.py`,
  the check is skipped and counts as not validated. It checks `td-scorer.json` with
  `sample.json`, which decides `validated`, and `td-scorer-budget.json` with
  `budget-sample.json`, which only sets `budget_validated`: any exit but 0 there is a
  warning, never a failed job.
- **publish** (main only, no secrets, and only after the check validated
  `td-scorer.json`): refuses a `td-scorer.json` with a budget block.
  `td-scorer-budget.json` keeps the refit's budget model when the check validated it
  and, if it has a block, `TD_SCORER_BUDGET`, read again and normalised the same way in
  shell, is `on`; otherwise it gets `td-scorer.json`'s model. Both files go to
  generated-stats in one commit, each left in place while its live copy's `enabled` is
  not true, and `td-scorer-budget.json` also while the live `td-scorer.json` is not
  enabled. A live file from a later refit (its version an ISO date after the run's and
  no later than today) is left in place too, both files when it is `td-scorer.json`. When the budget model was refused, a last step fails the job after
  the push.

## The gate

A model publishes when the floor (2) holds; the holdout (1) is reported only, because a
fixed 2026 window drifts away from what pytorch tests and would come to refuse a good
model. The floor and the holdout compare at TD's own cost per job: the scorer's cut may
cost no more than TD's own include list, which the gate rebuilds from the TD log's
aggregated scores the way `run_test.py` takes the top 25%. A job whose config has no
start-up k selects TD's include list on both sides, budget or not. With `--budget`, the
budget check (3) decides whether the model keeps its budget block.

1. **Holdout** (reported only, the unbiased view): the `td-holdout-unstable` runs of
   2026-08-30..09-18 ran every test file with TD off, so their failures are not biased
   toward what TD chose to run. For each PR-specific failure there (not broken on main
   that day, counted once per PR, config and file, and left out when a must-run
   heuristic scored the file, as in the walk-forward), the gate asks whether TD's
   include list and the scorer's cut held the file, and reports both counts. The holdout
   set is built once and stored write-once at
   `s3://ossci-raw-job-status/td_scorer/holdout/<SHARD_FORMAT>.jsonl.gz` (pull requests
   build it in memory), and only when it is complete: no fetch failed and at most 15% of
   the heads with a successful TD job lack its log. It is sound when it also has at
   least 40 failures outside must-run files (`MIN_HOLDOUT_EVENTS`); an unsound set is
   reported as such. Caveats:
   it is small, 54 failures in 32 PRs, 34 in 24 PRs once the must-run ones are left out
   (as of 2026-11, so below the 40 that make it sound), so a difference of a few
   failures is noise; its test jobs always conclude `success`, so a failure there is not
   required to have failed its job. Its PRs are left out of training.
2. **Floor**, over the walk-forward: for each calendar month that starts at least a
   month after the first healthy day, through the day before the refit, a scorer and a
   risk score are fitted on every healthy day before that month, without the month's PRs
   and the holdout PRs. Each month scores the PRs whose first TD run is in it, with
   their failures at the first failing head, minus the files a must-run heuristic scored
   there, which the scorer's cut always runs. Each PR with failures counts its recall
   for each side: of the scorer's cut, and of TD's include list as the gate rebuilds it.
   Pooled over the months, the scorer must reach 60% of TD (`FLOOR_RATIO`,
   `--floor-ratio`), over at least 30 PRs with failures (`MIN_FLOOR_PRS`). Before the
   scorer is published, the jobs ran TD's own cut, so TD's recall is about 1 and the
   measure favours TD. After it, failures are only observed in files the published
   scorer ran, so the months from then on favour the scorer, and the holdout stays the
   only unbiased view.

3. **Budget check** (only with `--budget`): every walk-forward model carries the block,
   and over the pooled months the per-PR detection retention of the budgeted cut, the
   share of PRs with failures inside TD's include list (at their first failing head,
   must-run files left out) for which the budgeted cut catches at least one of them,
   must reach `RETENTION_FLOOR` (`gate.py`, 0.65: with the start-up table of 2026-11-12
   the walk-forward of Jan-Nov 2026 gave 0.79 pooled over 966 PRs at the default window,
   0.75-0.92 in the months with 50 PRs or more; a guard against a broken model, not a
   quality target) over at least 30 such PRs. Only served jobs, those whose config has a
   start-up, count: the budget does not apply to the others. Otherwise refit writes
   `td-scorer-budget.json` without the block, and the scorer stays at TD's cost; the
   floor and the publish decision are unchanged. The refit settles the block first, then
   writes `--out` and `--sample` from the model without the block, and `--budget-out` and
   `--budget-sample` from the final model. Once the budget is live, PR failures are
   only observed in files the budgeted cut ran, so the check passes by construction:
   it guards the switch-on, not later drift.

The shipped model is fitted on the year's healthy days up to two days before the refit
(see "The data window"). Reported only, per month and in total: the units, the event
recall, the counted trunk landings and how many the scorer caught (TD none, by
construction), and the risk score's AUC on the months' PR heads; and the holdout counts
(failures, PRs, TD and scorer catches, mean files per job), the walk-forward's wall time
and the run's peak memory. With a budget, also the budgeted cut's catches and its
realised mean share of the jobs' cost and of their test-times seconds (ratios of sums
over a 1 in 20 hash sample of the served jobs), and the main-failure monitor: the last two
months' main landings with new, confirmed failures, replayed on the main push's TD log,
caught by the budgeted cut and by TD's 25% cut. The monitor is report only (any signal
taken after the rollout is selected against the deployed cut), runs after the model, the
report and the sample are written, never fails the run, and prints "unavailable" when
its fetch fails or takes longer than `gate.MONITOR_SECONDS`. That bounds the wait, not
the process: TD log fetches already queued when it gives up finish before the process
exits (minutes at worst, after everything is written).

## Candidate heuristics

A candidate is a heuristic pytorch's TD runs in trial mode, named in `train.CANDIDATES`
(`LLMSelection`): the TD log has its scores, so the day shards hold them, but it never
enters the shipped model (see "The model contract"). The refit reports what it would
add. For each walk-forward month with new PRs where a candidate ran and did not raise,
two models are fitted on the days before the month, as the walk-forward fits its own:
one over `train.HEURISTICS`, one with the candidates added, neither with a budget block.
Both score those PRs, and the month's counted trunk landings of those PRs, at TD's own
cost. Per month and pooled, the report gives TD's score, each model's score and its
ratio to TD's, the event recall of each, and the trunk landings each caught. A month
whose earlier days have no row where a candidate was active gives it no weight, so both
models agree there: the first month a candidate is logged shows no difference.

The report has the floor's bias: once the scorer is published, PR failures are only
observed in files the published cut ran, so a candidate that would have run other files
gets no credit from them. The counted trunk landings (tests TD skipped on the PR that
then broke trunk) are the view that is not biased that way.

It is report only: printed once the models and the samples are written, and added to
`--report` under `candidates`, it changes neither the shipped model nor the exit code,
and an error in it is logged, not raised. Each month with candidate PRs costs two more
fits; the months are taken newest first and none starts after
`walkforward.CANDIDATES_SECONDS` (30 minutes), so the report cannot use up the refit
job's time.

To promote a candidate, in this order:

1. pytorch drops the heuristic's `trial_mode`, so its scores reorder tests there.
2. Its name moves from `train.CANDIDATES` to `train.HEURISTICS`: the next refit fits it
   into the shipped model, and `check-pytorch` replays the gate's cut with pytorch's
   code.

## The test budget

pytorch's `scorer_model.py` defines the optional top-level block
`"budget": {"share": s, "spread": k, "cost_exponent": a}` and `model_json.py` mirrors it:

- **Bounds**, checked by pytorch's validator so that no model file can push PR testing
  below them: exactly these keys, finite numbers, `0 <= k < 1`, `0 <= a <= 1`,
  `0.10 <= s x (1 - k)` and `s <= 1`. The 0.10 floor (`MIN_SHARE`) bounds cost, not
  seconds: with each file's start-up k added, 10% of cost is a smaller share of
  test-times seconds.
- **The share** of a job's total cost (TD's include plus exclude lists) is
  `s x (1 + k x r)`, clamped to [0.10, 1], with r clamped to [-1, 1]. A change with an
  unknown r, or that touches build, dependency or test-infrastructure paths (`BUILD_*`
  in pytorch's `scorer_paths.py`, mirrored in `risk.py`, counted by the TD job into the
  block's `build_files`; an unknown count, a change listing no path, or one listing
  3,000 files or more counts as build paths), gets the top of the window, `s x (1 + k)`.
  The files are ranked by p / cost ** a, must-run files first, and fill the budget as
  whole files; the top-ranked file always runs, even when it costs more than what is
  left, so no file is too big ever to run. A job whose config has no start-up k keeps
  TD's own cut: the budget applies to the configs the model serves.
- **Staleness**: the TD job drops the block (the rest of the model stays) when the
  model's version is more than 3 days before today (UTC); the whole model goes after 7
  (see "The model contract").
- **Defaults**: `model_json.BUDGET`, the block `--budget` writes: s = 0.175 and
  k = 0.05 / 0.175, a window of 12.5% to 22.5% of cost, and a = 0.5.

The budget is opt-in: refit writes a block only when `TD_SCORER_BUDGET` is `on`, and the
gate's budget check passes. Before switching it on:

- pytorch main must have the budget rule. With the variable on and an older pytorch
  main, check-pytorch fails on `td-scorer-budget.json`, which then gets the plain model,
  and the run fails after publishing.
- Something must watch quality afterwards, because the budget check passes by
  construction once the budget is live: either an exploration slice (a small random
  share of jobs that run beyond the cut, so its misses stay observable), or a named
  person who reads the daily step summary and the main-failure monitor for the first
  weeks.

check-pytorch couples the two repos: while the budget is on, a pytorch change to the
budget constants, the build paths or `change_features` keeps the block out of
`td-scorer-budget.json`, and fails every run, until `model_json.py` and `risk.py` mirror
it; `td-scorer.json` has no block, so for it check-pytorch only warns.

### Turning the budget off

- `"enabled": false` in `td-scorer.json` (below) stops the scorer, budget included.
- To end the budget alone: set `TD_SCORER_BUDGET` to anything but `on`, cancel every
  in-flight run of the workflow (mandatory: a run that started with the variable on
  publishes a block after the key is deleted), and only then delete the key from the
  live `td-scorer-budget.json` (`jq -c 'del(.budget)' stats/td-scorer-budget.json > m.json
  && mv m.json stats/td-scorer-budget.json` on generated-stats, committed and pushed), or
  set its `enabled` to false (the daily run then leaves it in place until it is enabled
  again or deleted). Checkouts with the budget rule then use the model without a block.
  Deleting the file instead brings the block back on the next run while the variable
  is on.
- raw.githubusercontent.com caches the files for about 5 minutes, and a PR whose TD job
  already ran keeps that job's block for re-runs of its shards.
- Re-running the publish job of an old workflow run publishes none of its models over
  live ones of a later version.

Rollback order: the variable off, cancel in-flight runs (and re-run none of that day's),
delete `td-scorer-budget.json` from generated-stats, revert test-infra, then revert pytorch (checkouts with the budget
rule fall back to `td-scorer.json` when the budget file is missing, and older ones never
read it).

### The sweep

`python -m torchci.td.scorer sweep` replays the cut, read-only, at every point of a grid
of orders (`--orders`, p / cost ** a and TD's own ranking), spreads (`--spreads`) and
base shares (`--bases`), scored walk-forward (or by one `--model` file on the gate days).
Per point it writes one JSON row (realised share of cost and of seconds, main landings
and failures caught against TD's 25% cut, per-PR and per-event retention of TD's PR
catches, holdout catches by the model fitted before the holdout window) and per-landing
and per-PR vectors to an `.npz` next to it. It reads the shards and the holdout set from
`--cache-dir` only (a missing one fails the run before anything is written), test times
from `--test-times` and each config's start-up from the `start_up_seconds` of a model
file, `--start-up` or else `--model`'s (exactly one of them; their sha256 are recorded),
and main failures from `--main-cache`, fetched once and written there when the file is
absent; a cache of another window is refused, and so is an `--out` inside `--cache-dir`
or naming an input. Only served jobs count toward the realised share and the retention,
as in the gate. The `.npz` also holds each landing's and PR's r and budget mode. Bootstraps and
the selection of the defaults are not in this package.

## Turning the scorer off

Set `"enabled": false` in `stats/td-scorer.json` on the generated-stats branch. Every
pytorch checkout's TD job then uses TD's own cut, budget or not, and the publish job
writes neither file while it stays off. Setting it back to true (or deleting the file)
lets the next daily run publish again. "Turning the budget off" above ends the budget
alone.

## Running locally

From `tools/` with `pip install -e torchci`, and `CLICKHOUSE_ENDPOINT`,
`CLICKHOUSE_USERNAME` and `CLICKHOUSE_PASSWORD` set:

```bash
python -m torchci.td.scorer refit --day 2026-11-10 --train-days 2 --gate-days 1 \
  --cache-dir /tmp/td-shards --out /tmp/td-scorer.json --sample /tmp/sample.json \
  --budget-out /tmp/td-scorer-budget.json --budget-sample /tmp/budget-sample.json \
  --report-only
python -m torchci.td.scorer check-pytorch --model /tmp/td-scorer.json \
  --sample /tmp/sample.json --pytorch-root ../../pytorch
```

`--cache-dir` keeps day shards in a local directory instead of S3; `check-pytorch` reads
the sample `refit --sample` writes (`--budget-sample`'s for `td-scorer-budget.json`).
The sweep reads that cache directory, and takes the start-up table from a model file,
such as the published one:

```bash
curl -sSo /tmp/test-times.json \
  https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/test-times.json
curl -sSo /tmp/td-scorer.json \
  https://raw.githubusercontent.com/pytorch/test-infra/generated-stats/stats/td-scorer.json
python -m torchci.td.scorer sweep --day 2026-11-10 --cache-dir /tmp/td-shards \
  --test-times /tmp/test-times.json --start-up /tmp/td-scorer.json \
  --main-cache /tmp/main-failures.json --out /tmp/sweep.json \
  --orders 0.5,td --spreads 0,0.1,0.2
```
