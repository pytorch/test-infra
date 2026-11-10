# TD scorer

A model that ranks pytorch's test files for target determination (TD), retrained every
week. pytorch's TD job turns the TD heuristics' scores into p, the probability that a test
fails because of the change. Each test job then keeps 25% of its test files, as before,
ordered by p / cost ** a, where cost is the file's test time on that job plus 15 s and a
(0 to 1) is picked on that job so the 25% cost the same test time as TD's own 25% would.
The cut's CI cost stays as it was; only which files run changes. a = 1 is the order a
test-time budget would use.

## How it plugs into TD

- `.github/workflows/td_scorer.yml` refits the model every Monday and publishes it to the
  `generated-stats` branch as `stats/td_scorer.json`, as the rating files are published.
  A daily job checks the published model and how often pytorch fell back.
- pytorch's `tools/testing/do_target_determination_for_s3.py` downloads the file, and
  `tools/testing/target_determination/scorer/` evaluates it in pure Python. The TD job
  writes TD's heuristic sum to `td_results.json` as before, plus a `scorer` block with p for
  every test and the risk score, and emits one `td_scorer` metric per TD run.
- `run_test.py`'s cut step reads p and takes the matched order above. On any problem (no
  model, an unreadable or invalid file, `"enabled": false`, a feature pytorch does not know,
  missing test times, an exception), it takes TD's cut as before.

## The model file (format 1)

The contract between the two repos. `spec.py` names the features, `model_json.py`
validates and evaluates a model the way pytorch does, and a shared fixture
(`tests/td/fixtures/td_scorer_parity.json`) is tested in both repos.

- `format` (1), `enabled`, `trained_at`, `data_through`, `source` (run id, commit),
  `calibrated`, `features` (names, in column order), `scorer` (`baseline` and `trees`: per
  tree, parallel lists `feature`, `threshold`, `missing_left`, `left`, `right`, `value`,
  `leaf`), `platt` (`coef`, `intercept`, `clip`), `risk` (optional: `features`, `fill`,
  `mean`, `scale`, `coef`, `intercept`, `quantiles`, `share_min`, `share_max`) and `gate`
  (the gate's numbers, informational).
- p = Platt(sigmoid(baseline + the leaf values)): at each node a NaN goes to
  `missing_left`, a value <= `threshold` goes left; the sigmoid's output is clipped to
  [clip, 1 - clip] before Platt's logistic step.
- Risk = sigmoid(intercept + sum of coef * (x - mean) / scale), NaN inputs replaced by
  `fill`; the share is `share_min + (share_max - share_min) * F`, F the risk's percentile
  among `quantiles`.
- Limits pytorch enforces: at most 1000 trees, 255 nodes per tree, depth 8, 20000 nodes in
  all, 5 MB; every number finite. Every float is rounded to 9 decimals: the org's secret
  scanning blocks pushes holding a run of 15 or more digits.

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
- **Risk score** (recorded, not used): a logistic regression on landed changes predicting
  that a change newly breaks main, from the change alone: its files, source files, test
  files, docs-only flag, areas and significant lines added and deleted (the scorer's p is
  in-sample on training changes, so it is not an input). Each change weighs as the row
  builder subsampled it (1 / 0.2 for a kept main unit without a positive). Its share
  averages 15% over landed changes; its mean on PR runs is not calibrated.

## The gate and the checks

`python -m torchci.td.scorer refit` writes `td_scorer.json` only when a twin of the new
model, trained before the slices it is judged on, passes:

- against TD's own cut (replayed) on the last 28 settled days: the paired bootstrap's 95%
  upper bound of the twin's recall minus TD's is not below 0;
- against the live model, on the units after the live model's data, when there are at
  least 100 PR failures: the same bound of the twin minus live is not below 0;
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
  New TD runs fall back to TD's own cut within minutes (the test jobs of a workflow whose
  TD job already ran keep its ranking), and the weekly publish never replaces a disabled
  file. Turn it back on by setting `true` (the next refit then replaces it).
- **Roll back**: copy an earlier version of `stats/td_scorer.json` from the
  `generated-stats` history over the current one.
- **Logged scores**: `td_test_failure_stats_v2` keeps TD's own position and scores; when
  the model's cut ran, its `scorer` field holds the model, a and the deployed position.
