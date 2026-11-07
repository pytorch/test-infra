# TD before / after analysis

An offline evaluation of pytorch's target determination (TD): TD as served today
("before") against the end state of the TD improvement work ("after": decayed failure
ratings and co-edit PMI, the Qwen3 embedding heuristic, a calibrated ensemble over every
signal, a risk-driven per-change cutoff, and an exploration slice), on the same failures
and cutoffs. It writes one static HTML page.

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

- Populations: reverted trunk breakages (`td_trunk_breakages`), new failures on main,
  and PR-specific failures on TD-off (macOS) jobs.
- Policies: TD's cut at k% of test files; and the after system with a test-time budget
  (ranking by expected failures per second, the budget scaled per change by the risk
  model, with an exploration slice), at k% of test time on average and at the test time
  TD spends on the same change today.
- For each policy and cutoff: recall with intervals, precision per test file and per
  test hour, the share of test files and of test time run.
- Reds kept off main per quarter (central and high estimates), calibration and signal
  importance of the ensemble, and the risk model's precision / recall.
