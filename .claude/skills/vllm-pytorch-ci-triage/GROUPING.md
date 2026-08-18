# Grouping Guidance

Goal: ONE group per root cause, not per failing job.
## Common patterns

- **Same exception across sharded jobs**: `Fusion E2E Test (H100) - 1/4`
  through `4/4` all hit `MetaProxy` → one group.
- **Same ImportError across test suites**: multiple jobs fail on
  `ImportError: cannot import name 'X'` → one group.
- **Different tests, same underlying op**: `test_gemm` and `test_fused_add`
  both crash in the same custom op → one group if the exception chain
  points to the same call site.

## Anti-patterns

Do NOT group failures just because they share a job-name prefix or test
directory. Group by exception signature similarity.

## Signature field

Set `signature` to the representative exception string for the group —
typically `ExceptionClass: message` from the most common failure in the
group. This becomes the issue summary line.
