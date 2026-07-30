# Log-classifier regression fixtures

Real, verbatim CI-log fragments (GitHub-Actions timestamps + ANSI intact) from
failing `pytorch/pytorch` jobs, trimmed to a window that keeps the surrounding
*confusers* (generic `run_test.py` summaries, exit-code lines, teardown
tracebacks, OSDC/runner spew). Each fixture asserts "given this noisy log, does
the *correct* line win?"

The expectation lives **in-band** in each fixture (see `tests/classify.rs`):
the line the classifier currently lands on is prefixed with `#=MATCH=# ` and each
captured span is wrapped in `‹ ›` (so the group key is visible in context); a
fixture with no `#=MATCH=#` line records that nothing classifies. The marker
records the **current** verdict. Re-bless after a ruleset change with
`UPDATE_FIXTURES=1 cargo test --test classify`.

Note on the classifier's ignore-list: `src/log.rs` strips a few generic noise
lines *before* classification — notably `##[error]Process completed with exit
code N` and `##[error]Executing the custom container implementation failed`.
Two fixtures below hinge on this behavior.

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

After generating: rename to something descriptive. If the classifier lands on
the wrong line (or nothing) for a real failure, prefer fixing the ruleset so the
fixture blesses to the correct line, rather than checking in a wrong marker.

## Verification

`cargo test --test classify` passes (each fixture's `#=MATCH=#` marker — or its
absence — agrees with the live classifier).
