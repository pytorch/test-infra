# log-classifier — notes for agents

Rust AWS Lambda that classifies pytorch/pytorch CI logs. Rules live in
`ruleset.toml`; the engine is in `src/` (`log.rs` preprocesses, `engine.rs`
arbitrates by priority). See `README.md` for deployment.

## Regression fixtures (`tests/classify.rs`)

`fixtures/classify/*.txt` are real CI-log fragments (timestamps + ANSI intact)
with the expected verdict recorded **in-band**:

- `#=MATCH=# ` prefixes the line the classifier surfaces; each captured span is
  wrapped in `‹ ›` (so the group key is visible in context).
- A fixture with no `#=MATCH=#` line records that nothing classifies.
- An optional `#=SOURCE=#` line at the top links to the source job (metadata:
  never classified, preserved across re-blessing; written by `pull_fixture.py`).

The marker snapshots **current** behavior. Full format: `fixtures/classify/FIXTURES.md`.

## Reviewing fixtures (`git showfix`)

New fixtures are all-additions, so `git show` paints every log line green and
buries the `#=MATCH=#` line. `tools/color_fixture_diff.py` recolors a
`git show`/`git diff` stream: it dims the added log body, highlights only the
match line (and its `‹ ›` captures) and the `#=SOURCE=#` link, and leaves
non-fixture files (ruleset.toml, log.rs) in normal green. Wire up two aliases —
`showfix` for a single commit, `difffix` for a range/working tree (use
`git difffix main...HEAD` to review a whole branch; `git show` would list each
commit separately, so a fixture touched by two commits shows up twice):

```
git config alias.showfix '!f() { root="$(git rev-parse --show-toplevel)"; cd "${GIT_PREFIX:-.}" && git show --color=never "$@" | "$root/aws/lambda/log-classifier/tools/color_fixture_diff.py" | less -R; }; f'
git config alias.difffix '!f() { root="$(git rev-parse --show-toplevel)"; cd "${GIT_PREFIX:-.}" && git diff --color=never "$@" | "$root/aws/lambda/log-classifier/tools/color_fixture_diff.py" | less -R; }; f'
```

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

Finish by adding a row in `fixtures/classify/FIXTURES.md` (note the ideal answer
there if it's a known misclassification).
