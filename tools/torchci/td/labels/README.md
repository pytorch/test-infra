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
- `manifest.json`: units and positives per kind.

## Units

- `main` (`c:<sha>`): pushes to main that landed one commit. A file is positive when it
  newly broke at that push: it failed in a failed job of a config; at the previous push
  every shard of that config reported and the file failed in no job; it fails again in
  that config at the first of the next 3 pushes where the config reported. Every other
  test of the month's list is negative. `train_ok` is false when more than 50 files
  newly failed at the push (an infra-wide break).

## Limits

- Main units rebuild for as long as pushes, jobs and failed tests are kept.
- End the window at least 3 days ago: a main failure needs later pushes to be confirmed.
