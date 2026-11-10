# TD scorer

A model that ranks pytorch's test files for target determination (TD), retrained every
week. pytorch's TD job turns the TD heuristics' scores into p, the probability that a test
fails because of the change, and scores the change's risk of breaking main. Each test job
then runs a time budget instead of TD's 25% count cut: its test files ranked by p / cost
(cost: the file's test time on that job plus 15 s; ties by name), taken while the time
taken is below the change's share of the job's total test time (the file that crosses it
is kept). The share is `share_min + (share_max - share_min) * F`, F the change's risk
percentile among recent landed changes: riskier changes run more of their tests.

## How it plugs into TD

- `.github/workflows/td_scorer.yml` refits the model every Monday and publishes it to the
  `generated-stats` branch as `stats/td_scorer.json`, as the rating files are published.
  A daily job checks the published model and how often pytorch fell back.
- pytorch's `tools/testing/do_target_determination_for_s3.py` downloads the file, and
  `tools/testing/target_determination/scorer/` evaluates it in pure Python. The TD job
  writes TD's heuristic sum to `td_results.json` as before, plus a `scorer` block with p for
  every test and the risk score, and emits one `td_scorer` metric per TD run. It writes a
  fallback block instead when the model is missing, invalid, or trained more than 16 days
  before the run, or when a heuristic behind a feature the model reads raised.
- `run_test.py`'s cut step reads p and the budget share and takes the budget above, then
  draws TD's exploration from the files left out with a fixed 5% of the job's total test
  time, on top of the budget. On any problem (a fallback block, `"enabled": false`, no
  risk score, missing test times, an exception), it takes TD's cut as before.

## The model file (format 1)

The contract between the two repos. `spec.py` names the features, `model_json.py`
validates and evaluates a model the way pytorch does, and a shared fixture
(`tests/td/fixtures/td_scorer_parity.json`) is tested in both repos.

- `format` (1), `enabled`, `trained_at`, `data_through`, `source` (run id, commit),
  `calibrated`, `features` (names, in column order), `scorer` (`baseline` and `trees`: per
  tree, parallel lists `feature`, `threshold`, `missing_left`, `left`, `right`, `value`,
  `leaf`), `platt` (`coef`, `intercept`, `clip`), `risk` (optional: `features`, `fill`,
  `mean`, `scale`, `coef`, `intercept`, `quantiles`, `share_min`, `share_max`, and
  `paths` when a `path_*` feature is named: `base` and `nodes`, path keys to revert
  rates) and `gate` (the gate's numbers, informational).
- p = Platt(sigmoid(baseline + the leaf values)): at each node a NaN goes to
  `missing_left`, a value <= `threshold` goes left; the sigmoid's output is clipped to
  [clip, 1 - clip] before Platt's logistic step.
- A file's revert rate is that of the first of its own path, then its directories from
  the deepest ("a/b/c.py", "a/b/", "a/"), present in `paths.nodes` (keys over 512
  characters never match), else `paths.base`. `path_revert_max` and `path_revert_mean`
  are the log of the max and of the mean over the change's de-duplicated, sorted files
  (the first 10000), each at least 1e-6; NaN without files.
- Risk = sigmoid(intercept + sum of coef * (x - mean) / scale), NaN inputs replaced by
  `fill`; the share is `share_min + (share_max - share_min) * F`, F the risk's percentile
  among `quantiles`.
- Limits pytorch enforces: at most 1000 trees, 255 nodes per tree, depth 8, 20000 nodes in
  all, 5 MB; every number finite; at most 20000 path nodes, rates in [0, 1], keys
  non-empty, at most 512 characters, without control characters; 0.10 <= `share_min` <=
  `share_max` <= 0.40 (else the risk block, and with it the budget, is unusable). Every
  float is rounded to 9 decimals: the org's secret scanning blocks pushes holding a run
  of 15 or more digits.

## Training

- **Units and labels**: `torchci.td.labels`: single-commit pushes to main and PR-specific
  failures on TD-off jobs, over the last 360 days (the label builder reads PR labels back
  365 days), ending 3 days ago so labels settle. TD's failure metric only exists from
  2026-08-06, so units before it have no PR labels and no failure-correlation or
  previously-failed values (missing, not 0) until history accrues.
- **Features**, per (unit, test file): the scores the TD heuristics serve (previously
  failed, edited, mentioned, failure correlation, LLM, file path, public bindings), the
  test's time, PR or not, and the change's files, source files, test files, docs-only flag
  and areas. Training rebuilds each heuristic's input for the unit's day: the failure
  ratings with this repo's generator functions, the LLM score with `torchci.td.llm`'s
  retriever code and the published bundle. A PR's change is diffed against its merge base
  with the PR's base branch, as TD does (for ghstack, `gh/<user>/<N>/base`).
- **Scorer**: scikit-learn's `HistGradientBoostingClassifier` (depth 3, learning rate 0.05,
  up to 300 trees, 200 rows per leaf, L2 1.0, early stopping), Platt-scaled on the last 28
  days (42 or 56 when positives are scarce) by a twin fit before them.
- **Risk score**: a logistic regression on landed changes predicting
  that a change newly breaks main, from the change alone: its files, source files, test
  files, docs-only flag, areas and significant lines added and deleted (the scorer's p is
  in-sample on training changes, so it is not an input), plus the revert rates of the
  paths it touches. Each change weighs as the row builder subsampled it (1 / 0.2 for a
  kept main unit without a positive). F's quantiles are the order statistics of the risks
  of the landed changes of the 90 days before the cutoff, weighted alike, so the share
  averages the base over recent landed changes; failing PR jobs sit at a higher mean F.
- **The budget's range**: `share_min`/`share_max` = base -/+ 0.05, the base chosen by the
  gate (below): the smallest from 0.15 up to 0.35 that keeps PR recall within a point of
  TD's cut.
- **Path revert rates** (`pathrisk.py`), from the clone's main (first-parent history):
  a revert is a commit whose subject starts with `Revert ` or `Back out` and whose
  message's first `This reverts commit <sha>` names an older main commit. Over the
  non-revert commits of the 365 days up to 3 days before the table's time, a path's
  rate is (reverted + 20 x its parent's rate) / (touches + 20), the root's the overall
  rate; nodes touched fewer than 5 times, and keys holding a control character or a run
  of 15 digits, are left out (their parent's rate applies). The model file serves the
  table as of the cutoff; each training change reads the table as of the Monday 00:00
  UTC on or before its cutoff, so no change sees its own revert.

## The gate and the checks

`python -m torchci.td.scorer refit` writes `td_scorer.json` only when a twin of the new
model, trained before the slices it is judged on, passes:

- against TD's own cut (replayed) on the last 28 settled days: the twin, with its risk
  score and path table as of the slice's start, runs the budget per unit (each failing
  file's "need": the share of the job's test time ranked ahead of it; the budget keeps it
  when the need is below the share). The base is the smallest from 0.15 to 0.35, in steps
  of 0.01, whose PR failure recall minus TD's has a paired bootstrap (resampling PRs) 95%
  lower bound of at least -0.01; no such base fails the run. Fresh failures on main are
  reported beside it;
- against the live model, on the units after the live model's data, when there are at
  least 100 PR failures: both at a flat share equal to the chosen base, the paired
  bootstrap's 95% upper bound of the twin's recall minus live's is not below 0;
- calibration on landed changes over the last 56 days (at least 20 positives): mean p over
  the observed rate is within [0.5, 2]. New failures on main are rare, so this and Platt
  scaling are often skipped; the summary says whether the model is calibrated, and also
  reports calibration on the TD-off PR rows for information (a failure-selected population).

Otherwise the live model stays and the run fails, with the numbers in its summary.
`python -m torchci.td.scorer check` fails when the published model is older than 9 days or
cannot be read, or, with `--metrics`, when more than 10% of the last day's `td_scorer`
rows fell back. A failing scheduled run is the only signal. The gate replays TD's cut from
the same training features the model sees, so it cannot see their skew against what TD
served.

## Run it locally

```bash
pip install -r tools/torchci/requirements.txt -r tools/torchci/td/scorer/requirements.txt
pip install -r tools/torchci/td/llm/requirements-torch.txt \
  --index-url https://download.pytorch.org/whl/cpu
pip install -r tools/torchci/td/llm/requirements.txt
pip install -e tools/torchci
export CLICKHOUSE_ENDPOINT=... CLICKHOUSE_USERNAME=... CLICKHOUSE_PASSWORD=...  # read-only
python -m torchci.td.scorer refit --pytorch ~/pytorch --stats-dir <generated-stats>/stats \
  --live <generated-stats>/stats/td_scorer.json --out out/
```

## Operations

- **First model**: dispatch the workflow once from main after it lands; until a model is
  published, TD keeps its own cut and the daily check fails.
- **Turn it off**: set `"enabled": false` in `stats/td_scorer.json` on `generated-stats`.
  This is the only switch. New TD runs fall back to TD's own cut within minutes (the test
  jobs of a workflow whose TD job already ran keep its ranking), and the weekly publish
  never replaces a disabled file. Turn it back on by setting `true` (the next refit then
  replaces it). Each refit writes the budget's range itself, so a hand edit of
  `share_min`/`share_max` lasts only until the next publish.
- **Roll back**: copy an earlier version of `stats/td_scorer.json` from the
  `generated-stats` history over the current one.
- **Logged scores**: `td_test_failure_stats_v2` keeps TD's own position and scores; when
  the budget ran, its `scorer` field holds the model, the budget and the deployed
  position.
