# pytorch-advisor-coverage

A standalone AWS Lambda that drives down the `/flaky_trunk` page's
**unclassified** bucket — the isolated, non-persistent trunk reds that have no
attaching advisor verdict and that autorevert never evaluates (~40% of trunk
reds). It dispatches the `claude-autorevert-advisor.yml` workflow on those reds,
keyed to the OBSERVED trunk commit. The workflow writes the verdict JSON to S3;
the existing `clickhouse-replicator-s3` Lambda ingests it into
`misc.autorevert_advisor_verdicts`.

It vendors a few self-contained helpers from the sibling `pytorch_auto_revert`
package (ClickHouse/GitHub client factories, the dispatch primitive,
`RetryWithBackoff`, `parse_datetime`) but does NOT reuse its partition/signal
logic — targeting is a direct ClickHouse enumeration.

## What "unclassified" means (reused verbatim from /flaky_trunk)

Eligibility reuses the exact category=5 definition from torchci
`flaky_trunk_jobs/query.sql`: a trunk red is **unclassified** when it

- is red at a trunk commit, AND
- has NO attaching advisor verdict (related/revert/infra_issue/not_related/garbage)
  keyed to that commit, AND
- is NOT structurally persistent (no adjacent hard-red on the previous or next
  trunk commit) — i.e. an isolated single-commit hard-red, a retry-green, or a
  green→red→green flake.

The advisor classifies these well (a feasibility test caught a real regression
the persistence heuristic misses).

## The revert-isolation invariant (load-bearing)

The verdicts table is a **live control input**: autorevert reads it back and a
high-confidence `revert`/`related` verdict triggers a real revert. Its read-back
is an EXACT `signal_key` match.

Every coverage verdict carries `signal_key = "coverage_" + <native job signal_key>`
(the normalized job key — config kept, shard index + runner dropped). The prefix
keeps it out of autorevert's extracted key set, so it is **never attached and
never drives a revert or veto** — the same mechanism the PR-side Dr.CI path
(`dr_ci_`) already uses.

- The prefix is a **hard-coded module constant** `COVERAGE_SIGNAL_KEY_PREFIX`
  (`config.py`), NOT env/event configurable.
- It **must stay equal** to the `'^coverage_'` literal stripped in the
  `advisor_agg` CTE of torchci's flaky_trunk `query.sql` files (`flaky_trunk_jobs`,
  `flaky_trunk_timeseries`, `flaky_trunk_entity_runs`, `flaky_trunk_runner_labels`);
  that strip normalizes a coverage verdict onto the native job so it classifies
  the red on /flaky_trunk (see "How verdicts land on /flaky_trunk" below).
- A dispatch-time guard refuses to POST if the outgoing key is not safely
  prefixed (never equal to the native key).

## How a red becomes a dispatch

1. **Enumerate** currently-unclassified trunk reds for the window — one row per
   NORMALIZED job (config kept; shard index + runner dropped), reusing the
   flaky_trunk CTE chain — plus a few green baseline-before commits of that job
   (a second CH query).
2. **Windowless dedup**: skip any red that already has a `coverage_`-prefixed
   verdict for `(repo, observed commit, key)` — no time filter.
3. **Log-readability pre-filter**: HEAD-check the raw log at
   `ossci-raw-job-status/log/{job_id}` and skip stubs (<1000 bytes) or missing
   logs (~16% are unusable). Counted as `skipped_no_log`.
4. **Build** the isolated-red `signal_pattern` (failed suspect + green baselines)
   and **dispatch** with `suspect_commit = observed trunk commit`, `pr_number="0"`.

The advisor gets the diff from the workflow's OWN checkout of `suspect_commit`,
so the dispatch token needs no PR-read scope (`pr_number` is just metadata).

## How verdicts land on /flaky_trunk

Because a coverage verdict is keyed at the normalized-job level (`"coverage_" +
<native job signal_key>`), the `/flaky_trunk` SQL strips the leading `coverage_`
in `advisor_agg` and joins it on the SAME normalized job the page displays. A
coverage verdict therefore classifies — and reclassifies out of the unclassified
bucket — that normalized job at the observed commit, and the page prefers a native
verdict over a coverage one for the same (commit, job). No confidence gate is
applied: any non-`unsure` verdict is a classification.

## What it does NOT do

- Writes **nothing** to ClickHouse or S3. It only READS ClickHouse, HEAD-checks
  S3 logs, and POSTs `workflow_dispatch`.
- The minted GitHub installation token is scoped to `actions:write` only — it
  cannot push or revert.

## Ongoing vs backfill

- **Ongoing** (`MODE=ongoing`, the EventBridge cron): enumerate `[now - HOURS, now)`.
- **Backfill** (`MODE=backfill`): tile `[AS_OF_START, AS_OF_END)` into
  `AS_OF_STEP_HOURS` chunks and dispatch each chunk's unclassified reds,
  throttled + resumable.

### Running a long backfill (resume cursor)

A single Lambda invocation is bounded by a wall-clock budget and the dispatch
cap; when it stops early it returns `next_as_of`. Re-invoke with
`as_of_start = next_as_of` until it is `null`:

```jsonc
{"mode": "backfill", "as_of_start": "2026-02-19", "as_of_end": "2026-08-18"}
// response -> {"next_as_of": "2026-02-20T00:00:00", ...} ; repeat until null
```

Locally, one process completes the whole range (unlimited budget, only the gap
throttle applies):

```bash
MODE=backfill AS_OF_START=2026-02-19 AS_OF_END=2026-08-18 \
  python -m advisor_coverage.backfill
```

## Kill switch

- Set `DRY_RUN="true"` (the deploy default): logs intended dispatches, never
  POSTs. Flipping to `"false"` arms real dispatch.
- Or disable the EventBridge rule for the ongoing cron.

## Throttle

- `MAX_DISPATCHES_PER_RUN` (default 10) — per invocation, clamped by a compiled
  `HARD_CAP` (100) and the Lambda timeout budget; env/event may only LOWER it.
- `DISPATCH_GAP_SECONDS` (default 3) — sleep between dispatches (floored to 1s).

Cross-invocation duplicates (a red re-dispatched before its verdict lands) are
accepted: safe (prefixed → no reverts) and bounded by the throttle. Intra-run
duplicates from overlapping windows are suppressed in memory.

## Known limitation

Backfill chunks are enumerated with a persistence lookback/lookahead margin
(`PERSISTENCE_MARGIN_HOURS`) on each side, so a red at a chunk boundary still
sees its neighbouring trunk commits for the lag/lead persistence check (reds are
dispatched only within the core chunk). The one remaining edge is inherent: the
newest trunk commit in ongoing mode has no lookahead (the next commit doesn't
exist yet), so a just-observed red that will turn out persistent may be
dispatched once. This is bounded, safe (non-reverting), and matches
/flaky_trunk's own newest-commit semantics.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `CLICKHOUSE_HOST` / `CLICKHOUSE_PORT` | `localhost` / `8443` | read-only CH |
| `CLICKHOUSE_USERNAME` / `CLICKHOUSE_PASSWORD` | `""` | reuse `CLICKHOUSE_USER_AUTO_REVERT`; password from Secrets Manager |
| `CLICKHOUSE_DATABASE` | `default` | |
| `GITHUB_APP_ID` / `GITHUB_INSTALLATION_ID` | `""` / `0` | GitHub App; PEM from Secrets Manager |
| `GITHUB_APP_SECRET` / `GITHUB_TOKEN` | `""` | base64 PEM / raw token (local dev) |
| `SECRET_STORE_NAME` | `""` | `pytorch-autorevert-secrets` in prod |
| `REPO_FULL_NAME` | `pytorch/pytorch` | pinned to an allowlist |
| `WORKFLOWS` | empty = all | optional JSON array / CSV filter |
| `HOURS` | `24` | ongoing enumeration window |
| `MIN_RUNS` | `20` | min total runs for a job to be enumerated (matches /flaky_trunk) |
| `MODE` | `ongoing` | `ongoing` \| `backfill` |
| `AS_OF_START` / `AS_OF_END` | — | backfill range (UTC) |
| `AS_OF_STEP_HOURS` | `24` | backfill chunk size |
| `MAX_DISPATCHES_PER_RUN` | `10` | see Throttle |
| `DISPATCH_GAP_SECONDS` | `3` | see Throttle |
| `DRY_RUN` | `true` | `false` arms real dispatch |
| `LOG_LEVEL` | `INFO` | secret-leaking loggers pinned to WARNING regardless |

The `coverage_` prefix is intentionally NOT an env var.

## Local run + tests

```bash
python -m advisor_coverage                 # ongoing dry-run (set CLICKHOUSE_* first)
make test                                  # mocked unit tests, no network
```

## Build / deploy

`make deployment.zip` vendors the three needed `pytorch_auto_revert` helper
modules plus the Python deps. The handler is
`advisor_coverage.handler.lambda_handler`. Deploy plumbing (terraform +
EventBridge cron + IAM) lives in `pytorch-gha-infra`.
