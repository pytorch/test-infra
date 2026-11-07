# TD before / after analysis

An offline evaluation of pytorch's target determination (TD): TD as served today
("before") against the end state of the TD improvement work ("after": decayed failure
ratings and co-edit PMI, the Qwen3 embedding heuristic, an ensemble over every signal
ranking tests by expected failures per second, a test-time budget the risk model scales
per change, and an exploration slice), on the same failures. It writes one static HTML
page.

## Run

```bash
python -m venv venv && venv/bin/pip install -r tools/torchci/requirements.txt \
  -r tools/torchci/td/analysis/requirements.txt && venv/bin/pip install -e tools/torchci
# The llm step needs td/llm's requirements (torch, sentence-transformers) in its own venv.
export CLICKHOUSE_ENDPOINT=... CLICKHOUSE_USERNAME=... CLICKHOUSE_PASSWORD=...  # read-only
for step in fetch labels rankings llm features train evaluate report; do
  venv/bin/python -m torchci.td.analysis $step --cache <cache dir> --pytorch <pytorch clone>
done
```

Every step writes its tables and a manifest under `<cache dir>/<step>/` and refuses to
run when a step before it has not finished. The pytorch clone is only read. The `fetch`
step reads HUD ClickHouse with parameterised, read-only queries; the `features` step
expects a clone of test-infra's `generated-stats` branch at `<cache dir>/../gs` and an
archive of pytorch's `tools/` and `test/` at `<cache dir>/../pytorch-src`; the `llm` step
expects td/llm's model, embedding cache and PR diffs at `<cache dir>/../llm_cache`.

## What it measures

- Populations: reverted trunk breakages (`td_trunk_breakages`) and PR-specific failures
  on TD-off (macOS) jobs, evaluated from 2026-08-17 (TD's logged rankings, which both
  need, start 2026-08-06); and new failures on main, evaluated from 2026-01-05 on landed
  changes since 2025-11-10, cut over each change's full test list. The page charts the
  fresh ones (the test did not fail on main in the 14 days before): the others are
  mostly flaky re-failures, which dominate parts of the year.
- Limits of the long window before mid-2026: generated-stats kept no rating files before
  2026-07-02, so TD's replay there reads failure and co-edit ratings rebuilt with the
  generators' formulas of the time (results.json's `rebuild_check` compares them with the
  live files where both exist); PreviouslyFailedInPR has no PR failures before
  2026-08-06 (they come from TD's logs); test times are the 2026-07-15 file throughout;
  C++ test names join the candidates only from August 2026.
- Policies: TD's cut at k% of test files; and the after system with a test-time budget
  (ranking by expected failures per second, the budget scaled per change by the risk
  model, with an exploration slice), at k% of test time on average and at the test time
  TD spends on the same change today.
- For each policy and cutoff: recall with intervals, precision per test file and per
  test hour, the share of test files and of test time run.
- The ensemble's signal importance. results.json also holds reds kept off main per
  quarter, the ensemble's calibration, the risk model's precision / recall and the
  replay's fidelity, which the page does not show.
