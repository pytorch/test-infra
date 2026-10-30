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

- **Same stopping point across different jobs**: two jobs whose logs stop right after the same progress
  line (for example `Using LBNHC KV cache layout.`) are one group, even on different GPUs and without any
  exception text. Say that the shared cause is likely, not proven.
- **Cascade members attach to the head**: later failures caused by an earlier hung command in the same job
  (`Free memory ... less than desired` after `Killing process N ...`) belong in the group of the hang, not in
  a startup free-memory group.

## Anti-patterns

Do NOT group failures just because they share a job-name prefix or test
directory. Group by exception signature similarity.

Do NOT put a `timed_out` job into an exception group (CUDA init, free memory) because it also failed on
the nightly lane: it joins that group only if its own tail contains that signature.

## Signature field

Set `signature` to the representative exception string for the group —
typically `ExceptionClass: message` from the most common failure in the
group. This becomes the issue summary line.
