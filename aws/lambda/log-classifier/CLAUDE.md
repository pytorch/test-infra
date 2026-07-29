# log-classifier — notes for agents

Rust AWS Lambda that classifies pytorch/pytorch CI logs. Rules live in
`ruleset.toml`; the engine is in `src/` (`log.rs` preprocesses, `engine.rs`
arbitrates by priority). See `README.md` for deployment.

## Regression fixtures (`tests/classify.rs`)

`fixtures/classify/*.txt` are real CI-log fragments (timestamps + ANSI intact)
with the expected verdict recorded **in-band**:

- `#=MATCH=# ` prefixes the line the classifier surfaces; each captured span is
  wrapped in `‹ ›` (so the group key is visible in context).
- `#=NO-MATCH=#` records that nothing classifies.
- `#=WANT=# <note>` lines are human annotations — never asserted.

The marker snapshots **current** behavior. Full format: `fixtures/classify/FIXTURES.md`.

- Run: `cargo test --test classify`
- Re-bless after a ruleset/engine change (verify the diff before committing!):
  `UPDATE_FIXTURES=1 cargo test --test classify`

## Adding a fixture from a failing job

Prefer `./pull_fixture.py` over hand-collecting a log. Pass anything carrying the
job id — a bare id, a GitHub Actions job URL (`.../job/<id>`), or a raw-log URL:

```
./pull_fixture.py <job-id | job-URL | log-URL> --name <case>
```

It downloads the raw log from public S3, runs *this crate's* classifier to find
the line it surfaces, trims to that line ± `--context` (default 60), writes
`fixtures/classify/<case>.txt`, blesses the markers, and prints where the
classifier landed.

Then: **confirm the marked line is the real failure**. If the real cause was
trimmed off, re-run with a larger `--context`, or pin the window with
`--grep <regex>` / `--lines <A-B>` (1-based raw line numbers; `--stdout` prints
the numbered log to help pick a range). `--no-bless` writes offline, anchoring on
the last `##[error]` / exit-code line instead of the classifier.

Finish by adding a `#=WANT=#` note if it's a known misclassification and a row in
`fixtures/classify/FIXTURES.md`.
