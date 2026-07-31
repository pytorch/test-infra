# PyTorch Green Light

A Python service that runs a periodic iteration from the CLI — a one-shot
(cron-like) run by default, or a long-lived daemon with `--loop`.

## Requirements

- **mise** — the only manual prerequisite. See <https://mise.jdx.dev>.

Everything else (Python 3.14, uv, just, and the non-Python linters) is provided
by mise; `just setup` then installs the Python tools (ruff, mypy, pytest, yamllint).

## Setup

```bash
mise trust      # trust greenlight/mise.toml on first use
mise install    # install python 3.14, uv, just, and all tools
just setup      # uv sync -> create .venv with deps
```

## Usage

PyTorch Green Light has two subcommands. `review` fetches the open PRs from a fixed
set of trusted authors in `pytorch/pytorch` (a live, read-only GitHub call that
requires `PYTORCH_GREENLIGHT_GITHUB_TOKEN`) and logs them. `verdict` records a single
PR-review verdict and acts on the PR (see below). Risk-scoring and the AI code-review
workflow that produces the verdict are planned — see the Current status section below.

```bash
just run review                      # run the review phase once, then exit
just review                          # convenience alias for `just run review`
just run review --loop               # run the review phase forever as a daemon
just run review --loop --interval 30 # daemon, 30s between iterations
```

The `review` examples require `PYTORCH_GREENLIGHT_GITHUB_TOKEN` to be set; without it
`review` exits non-zero.

### Recording a verdict

A privileged CI job records a review verdict with `verdict`. It runs once (never a
daemon): it emits a gzipped single-line JSON row (whose `reason` must be a canonical
`ALLOWED_REASONS` code) that the record workflow uploads to
`s3://gha-artifacts/greenlight_pr_state/`, where the clickhouse-replicator-s3 path ingests
it into `misc.greenlight_pr_state` — the command never writes ClickHouse directly. Then,
for `LAND`/`NO_LAND`, it acts on the PR (`LAND` approves; `NO_LAND` dismisses greenlight's
own prior approval and comments). `CANCELLED` and `FAILED` markers only emit the row. The
model's message is defanged before it is posted to GitHub, while the full message is stored
verbatim in the emitted row.

```bash
just run verdict --pr 123 --head-sha "$SHA" --verdict-file verdict.json \
  --eval-hash "$EVAL_HASH" --bot-login 'greenlight-app[bot]'   # LAND/NO_LAND
just run verdict --pr 123 --head-sha "$SHA" --status CANCELLED  # marker: emit row only
just run verdict --pr 123 --head-sha "$SHA" --verdict-file verdict.json \
  --eval-hash "$EVAL_HASH" --dry-run                            # offline; logs only
```

The command writes the gzipped row to `/tmp/greenlight-verdict-row.json.gz` and its
bucket-relative key to `/tmp/greenlight-verdict-key.txt`; the workflow `aws s3 cp`s the
former to the latter. There is no direct ClickHouse write, so no `CLICKHOUSE_*` credentials
are needed here; `verdict` needs `PYTORCH_GREENLIGHT_GITHUB_TOKEN` to post `LAND`/`NO_LAND`,
and `--dry-run` needs nothing. `--bot-login` (the greenlight GitHub App's `<slug>[bot]`
account) is required for `NO_LAND`.

Configuration is read from the environment via `PYTORCH_GREENLIGHT_*` variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PYTORCH_GREENLIGHT_GITHUB_TOKEN` | unset | GitHub token for read-only PR access; required by `review` |
| `PYTORCH_GREENLIGHT_INTERVAL_SECONDS` | `60` | Seconds between iterations in `--loop` mode |
| `PYTORCH_GREENLIGHT_LOG_LEVEL` | `INFO` | Logging level (e.g. `INFO`, `DEBUG`) |
| `PYTORCH_GREENLIGHT_LOCK_PATH` | unset | Lock file path guarding against concurrent runs (unset = no lock) |
| `PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS` | `600` | Per-iteration hard cap on runtime (`0` = disabled) |
| `PYTORCH_GREENLIGHT_BACKOFF_BASE_SECONDS` | `1` | Base backoff after a failed iteration (daemon mode) |
| `PYTORCH_GREENLIGHT_BACKOFF_MAX_SECONDS` | `60` | Maximum backoff between retries (daemon mode) |

`PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS` (default `600`, `0` = disabled) bounds every
iteration in both one-shot and `--loop` mode. In `--loop` mode, SIGTERM/SIGINT are
observed only between iterations, so the per-iteration timeout is what interrupts a
hung run.

## Current status

Works today: the CLI runs the `review` phase once (cron-like) or as a `--loop` daemon,
with a single-instance lock, a per-iteration soft timeout plus a hard watchdog, backoff
on failure, and clean signal shutdown — all built and tested. `review` fetches the open
PRs from a fixed set of trusted authors in `pytorch/pytorch` (read-only GitHub) and
logs them; it requires `PYTORCH_GREENLIGHT_GITHUB_TOKEN`.

Also works: the `verdict` subcommand emits a PR-review verdict row (with the passed-in
`eval_hash` verbatim) for the record workflow to upload to
`s3://gha-artifacts/greenlight_pr_state/`, where the clickhouse-replicator-s3 path ingests
it into `misc.greenlight_pr_state`; for LAND/NO_LAND it also acts on the PR — approve, or
dismiss greenlight's prior approval and comment. It is a one-shot call for a privileged CI
job and never writes ClickHouse directly. The service keeps ClickHouse READ access
(`clickhouse_client.connect()`) for its own SELECTs.

Not built yet: risk-scoring and the review decision in `review`; the AI code-review
workflow (a separate component) that produces the verdict; and the review-side
fingerprint computation plus the land-time verifier. `verdict` stores the `eval_hash`
verbatim, but greenlight does not yet compute it in `review`, and nothing consumes
`misc.greenlight_pr_state` at land time yet.

When wired, the land-time verifier must look up stored state by `(repo, pr_number)`
— the ledger's `ORDER BY` key — never by `eval_hash` alone: the fingerprint omits
repo and PR number, so a hash-only lookup would let one PR's approval replay onto a
different PR. The writer (greenlight) and the verifier (pytorchbot) run the identical
`pr_hash` / `build_pr_fingerprint` code and upgrade hash schemes together.

## Development

```bash
just lint        # ruff, markdownlint, shellcheck, shfmt, yamllint, taplo
just lint-fix    # auto-fix what the linters can
just typecheck   # mypy (strict)
just test        # pytest + coverage (>=97%)
```

All gates must pass before a change is complete.

## Layout

```text
src/greenlight/
  __init__.py      # package exports (Config, __version__)
  __main__.py      # `python -m greenlight` entry point
  cli.py           # CLI parsing (review + verdict subcommands), dispatch, exit codes
  runner.py        # run_forever(): resilient daemon loop; execute_once(): one-shot phase run
  review.py        # fetch open PRs from trusted authors in pytorch/pytorch and log them; raises on failure
  verdict.py       # one-shot: emit a verdict row for S3->replicator, then approve/dismiss/comment on the PR
  github_client.py # GitHub PR access: read PR list/fingerprint + post verdict actions
  clickhouse_client.py # ClickHouse connection helper for the service's read (SELECT) queries
  pr_hash.py       # eval_hash land-guard: deterministic PR fingerprint hash
  config.py        # PYTORCH_GREENLIGHT_* environment configuration
  guards.py        # single-instance lock + per-iteration SIGALRM timeout + hard watchdog
  log.py           # logging setup
  exit_codes.py    # process exit codes
tests/             # unit tests mirroring the modules above
```
