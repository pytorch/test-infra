# TD scorer: the test budget

pytorch's `scorer_model.py` defines the optional top-level block
`"budget": {"share": s, "spread": k, "cost_exponent": a}` and `model_json.py` mirrors it:

- **Bounds**, checked by pytorch's validator so that no model file can push PR testing
  below them: exactly these keys, finite numbers, `0 <= k < 1`, `0 <= a <= 1`,
  `0.10 <= s x (1 - k)` and `s <= 1`. The 0.10 floor (`MIN_SHARE`) bounds cost, not
  seconds: with start-up k per file, 10% of cost is a smaller share of test-times seconds.
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
  (README, "The model contract").
- **Defaults**: `model_json.BUDGET`, the block `--budget` writes: s = 0.175 and
  k = 0.05 / 0.175, a window of 12.5% to 22.5% of cost, and a = 0.5.

The budget is opt-in: refit writes a block only when `TD_SCORER_BUDGET` is `on`, and the
gate's budget check passes. Before switching it on:

- pytorch main must have the budget rule. With the variable on and an older pytorch
  main, check-pytorch fails on `td-scorer-budget.json`, which then gets the plain model,
  and the run fails after publishing.
- Something must watch quality afterwards, as the budget check passes by construction
  once the budget is live: an exploration slice (a small random share of jobs run beyond
  the cut, so its misses stay observable), or a named person reading the daily step
  summary and the main-failure monitor for the first weeks.

check-pytorch couples the two repos: while the budget is on, a pytorch change to the
budget constants, the build paths or `change_features` keeps the block out of
`td-scorer-budget.json`, and fails every run, until `model_json.py` and `risk.py` mirror
it; `td-scorer.json` has no block, so for it check-pytorch only warns.

## Turning the budget off

- `"enabled": false` in `td-scorer.json` (README, "Turning the scorer off") stops the scorer, budget included.
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

## The sweep

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
