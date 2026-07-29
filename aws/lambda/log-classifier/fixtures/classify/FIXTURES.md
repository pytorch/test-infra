# Log-classifier regression fixtures

Real, verbatim CI-log fragments (GitHub-Actions timestamps + ANSI intact) from
failing `pytorch/pytorch` jobs, trimmed to a window that keeps the surrounding
*confusers* (generic run_test.py summaries, exit-code lines, teardown
tracebacks, OSDC/runner spew). Each fixture asserts "given this noisy log, does
the *correct* line win?"

The expectation lives **in-band** in each fixture (see `tests/classify.rs`):
the line the classifier currently lands on is prefixed with `#=MATCH=# ` and each
captured span is wrapped in `‹ ›` (so the group key is visible in context), or a
`#=NO-MATCH=#` line records that nothing classifies. `#=WANT=# ...` lines are
human notes (the *ideal* answer) and are never asserted. The marker records the
**current** verdict — which for the bucket-(A) cases below is deliberately wrong,
documenting the bug rather than fixing it. Re-bless after a ruleset change with
`UPDATE_FIXTURES=1 cargo test --test classify`.

This batch is an initial RFC set of **5 fixtures** (capped for review before
scaling to the full 10–15).

Note on the classifier's ignore-list: `src/log.rs` strips a few generic noise
lines *before* classification — notably `##[error]Process completed with exit
code N` and `##[error]Executing the custom container implementation failed`.
Two fixtures below hinge on this behavior.

| # | fixture | source | family | ideal classification | current verdict | verdict |
|---|---------|--------|--------|----------------------|-----------------|---------|
| 1 | `unittest_failed_consistently.txt` | [job 90353239384](https://github.com/pytorch/pytorch/actions/runs/30381638998/job/90353239384) | python unittest failure | `FAILED CONSISTENTLY: .../test_vars_traced_correctly_under_compile_dynamic_shapes` | rule **Python unittest failure**, same line | **correct** |
| 2 | `lint_lintrunner.txt` | [job 90443302071](https://github.com/pytorch/pytorch/actions/runs/30409804419/job/90443302071) | lint (lintrunner/RUFF) | a `>>> Lint for <file>` finding | rule **Lintrunner failure**, `>>> Lint for benchmarks/distributed/bench_symmetric_memory_all_gather.py:` | **correct** |
| 3 | `pr_sanity_exit_code_only.txt` | [job 90436205612](https://github.com/pytorch/pytorch/actions/runs/30407531818/job/90436205612) | infra / script check (exit-code-only confuser) | `Your PR is 3174 LOC which is more than the 2000 maximum` | **NO MATCH** | **MISCLASSIFIED** |
| 4 | `infra_osdc_pod_failure.txt` | [job 90079771913](https://github.com/pytorch/pytorch/actions/runs/30295386157/job/90079771913) | infra (k8s pod / OSDC container) | `##[error]Error: pod failed to come online ... is unhealthy with phase status Pending` | rule **GHA error**, that pod-failure line | **correct** |
| 5 | `distributed_test_wrapper.txt` | [job 89562487765](https://github.com/pytorch/pytorch/actions/runs/30116811778/job/89562487765) | distributed test failure | `TestC10dTorchCommsBackendConfig - failed. This test class should extend from torch.testing._internal.common_utils.TestCase but it doesn't.` | rule **Python Test File RuntimeError**, `RuntimeError: distributed/test_c10d_torchcomms 1/1 failed!` | **MISCLASSIFIED** |

Raw-log URLs (public, gzip-stored — pipe through `gunzip`):
`https://ossci-raw-job-status.s3.amazonaws.com/log/<jobId>`

## Adding a fixture

Use `../../pull_fixture.py` (in the crate root) to turn a failing job into a
fixture. Pass anything that carries the job id — a bare id, a GitHub Actions job
URL, or a raw-log URL:

```
./pull_fixture.py https://github.com/pytorch/pytorch/actions/runs/<run>/job/<jobId> --name my_case
```

It downloads the raw log, runs *this crate's* classifier to find the line it
surfaces, trims to that line ± `--context` (default 60), writes
`fixtures/classify/my_case.txt`, and blesses the markers — then prints where the
classifier landed. Confirm that line is the real failure; if the real cause got
trimmed off, re-run with a larger `--context`, or pin the window with
`--grep <regex>` / `--lines <A-B>` (1-based raw line numbers; `--stdout` prints
the numbered log to help you pick). `--no-bless` writes the window offline
(anchoring on the last `##[error]` / exit-code line instead of the classifier).

After generating: rename to something descriptive, add a `#=WANT=#` note if it's
a known misclassification, and add a row to the table above.

## Per-fixture notes

### 1. `unittest_failed_consistently.txt` — correct
`dynamo/test_dynamic_shapes` shard, aarch64. Window holds the three per-test
`FAILED [0.38s] ...::test_*` pytest lines (would match the lower-priority
**pytest failure** rule), the `FAILED CONSISTENTLY: ...` summaries (the
higher-priority **Python unittest failure** rule), and the even-lower-priority
`The following tests failed consistently: [...]` fallback line. The classifier
correctly picks the last `FAILED CONSISTENTLY` line over all of these.

### 2. `lint_lintrunner.txt` — correct
`lintrunner-noclang-partial`. Two `>>> Lint for <file>:` blocks (RUFF TC003 /
S101), then the trailing OSDC + `##[error]Process completed with exit code 1`
noise. The exit-code line is on the ignore-list; the classifier surfaces the
last `>>> Lint for` block. (Minor: the ideal capture might name the RUFF code,
but the current line is the right family.)

### 3. `pr_sanity_exit_code_only.txt` — MISCLASSIFIED (NO MATCH)
`pr-sanity-checks`. The real reason is printed in plain English —
`Your PR is 3174 LOC which is more than the 2000 maximum allowed within PyTorch
infra.` — but no rule matches it, and the only `##[error]` line
(`Process completed with exit code 1.`) is stripped by the ignore-list. Result:
the classifier surfaces **nothing**. Ideal: surface the "PR is N LOC ..." line
(there is no rule for it today).

### 4. `infra_osdc_pod_failure.txt` — correct
`inductor_cpp_wrapper` on an OSDC runner whose pod never came online. Window
holds the k8s pod-health `##[error]`, a JS `TypeError: Cannot read properties
of null (reading 'jobPod')`, and the generic exit-code / custom-container
`##[error]` lines. Because the two generic lines are on the ignore-list, the
**GHA error** rule lands on the real cause (`pod failed to come online ...
unhealthy with phase status Pending`). Good demonstration that the ignore-list
does its job.

### 5. `distributed_test_wrapper.txt` — MISCLASSIFIED
`linux-jammy-py3.10-gcc11 / test (distributed, 1, 8)`. The real cause is
`TestC10dTorchCommsBackendConfig - failed. This test class should extend from
torch.testing._internal.common_utils.TestCase but it doesn't.` — a misconfigured
test class, matched by no rule. The classifier instead wins on the generic
run_test.py wrapper `RuntimeError: distributed/test_c10d_torchcomms 1/1 failed!`
(**Python Test File RuntimeError**), which tells you only *that* the file failed,
not *why*. Ideal: surface the "should extend from ... TestCase" line.

## Verification

`cargo test --test classify` passes (each fixture's `#=MATCH=#` / `#=NO-MATCH=#`
marker agrees with the live classifier).
