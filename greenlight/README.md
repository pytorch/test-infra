# PyTorch Green Light

A Python service that runs a periodic iteration from the CLI — a one-shot
(cron-like) run by default, or a long-lived daemon with `--loop`. In production the
scheduled scan runs as an AWS Lambda (`greenlight-scan`) on a 5-minute EventBridge
schedule; the CLI one-shot and `--loop` daemon modes remain for local and other use.

## Requirements

- **mise** — the only manual prerequisite. See <https://mise.jdx.dev>.

Everything else (Python 3.13, uv, just, and the non-Python linters) is provided
by mise; `just setup` then installs the Python tools (ruff, mypy, pytest, yamllint).

## Setup

```bash
mise trust      # trust greenlight/mise.toml on first use
mise install    # install python 3.13, uv, just, and all tools
just setup      # uv sync -> create .venv with deps
```

## Usage

PyTorch Green Light has three subcommands. `review` scans the open PRs from a fixed set of
trusted authors in `pytorch/pytorch` and, for each one, computes its fingerprint
(`eval_hash`), reads the PR's latest recorded state from ClickHouse
`misc.greenlight_pr_state`, and dispatches the reviewer workflow
(`greenlight-pr-review.yml` on `pytorch/test-infra`) for PRs that are new or changed since
their last review. Draft PRs are dropped from the listing scan entirely — never fingerprinted or
dispatched. That drop lives in the listing fetch alone, so `greenlight review --pr N` reviews a
draft like any other PR; a draft never reaches that path through `@greenlight recheck`, because
the bot turns a draft down before it dispatches (see "Rechecking a PR"). A PR whose `updated_at`
is older than `PYTORCH_GREENLIGHT_REVIEW_WINDOW_HOURS` (default 24), or that carries the `Stale`
label, is skipped without fingerprinting unless it has an in-flight or retry-eligible
(cancelled/failed) review to re-check; an explicit `@greenlight recheck` (the `--pr` path) reviews
it regardless. An in-flight review — one marked `AI_REVIEW_STARTED` — is left alone until the
`--timeout-minutes` re-dispatch window elapses.
The listing scan also skips a PR a human has already decided — approved by a merge-authorized
login (any `approved_by` in `pytorch/pytorch`'s `merge_rules.yaml`, taken across all rules
regardless of the PR's changed paths, bots excluded) or with changes requested by any non-bot
reviewer — without fingerprinting or dispatching it. No state is written for such a skip, so the
scan resumes on its own once the situation changes (for example the changes-requested review is
dismissed). `verdict` records a single
PR-review verdict and acts on the PR, and `drci-poke` refreshes the Dr. CI comment that shows
that verdict on `pytorch/pytorch` (both below).

```bash
just run review                      # scan + dispatch once, then exit
just review                          # convenience alias for `just run review`
just run review --loop               # scan + dispatch forever as a daemon
just run review --loop --interval 30 # daemon, 30s between iterations
just run review --pr 123             # scan only PR #123 (its author must be trusted)
just run review --pr 123 --requester alice  # recheck PR #123 for alice (author and alice must be trusted)
just run review --max 5              # cap this iteration at 5 dispatches
just run review --ref my-branch      # dispatch the reviewer workflow at this test-infra ref (default main)
just run review --timeout-minutes 60 # re-dispatch an in-flight review after 60 min (default 45)
just run review --pr 123 --force     # re-dispatch PR #123 even if already decided (needs --pr, not --loop)
just run review --pr 123 --allow-untrusted-author  # LOCAL ONLY: skip the --pr author check
```

`review` requires `PYTORCH_GREENLIGHT_GITHUB_TOKEN`, and any scan that finds at least one
trusted-author PR also reads ClickHouse, so the `CLICKHOUSE_*` credentials must be set in
practice; without the token `review` exits non-zero.

The default `--timeout-minutes` is 45, above the reviewer workflow's own ~37-40 min
budget, so with the default the scanner lets a running review finish (or time out and
record a verdict) before it re-dispatches, rather than cancelling and restarting one that
is still running. Lower `--timeout-minutes` in the deployment if you need a stuck review
reclaimed sooner.

### Rechecking a PR (`@greenlight recheck`)

A trusted author can re-trigger a review by commenting `@greenlight recheck` on a
`pytorch/pytorch` PR. The greenlight Probot bot in torchci
(`torchci/pages/api/greenlight/webhooks.ts`) understands two commands, `recheck` and `help`;
`@greenlight help` replies with the list of available commands and has no other effect — no
comment beyond that reply, no label change, no dispatch.

The command is read the way a human reads it, not the way a shell would: mention and command name
are both matched case-insensitively, the mention must open its line, and a mention that renders as
sample text rather than as an instruction — inside a fence, an HTML comment or a `<pre>` block, or
indented far enough to be a markdown code block — is ignored. Those regions need no closing
delimiter to count, so an unterminated `<!--` swallows the rest of the comment, exactly as GitHub
does when it renders nothing there. Matching the mention case-insensitively is what keeps the bot
in step with `pr_hash.is_bot_command`, which lowercases the body before looking for the trigger: a
differently-cased mention is dropped from the PR's fingerprint whether or not the bot acts on it.

An accepted `recheck` does its work in this order: it removes the `Stale` label if the PR carries
it, dispatches `greenlight-review.yml` with the PR number and the commenter's login as
`--pr N --requester <login>` — which puts the PR through the scan's `--pr` path — and only then
acknowledges, with a comment plus a reaction on the triggering comment. The acknowledgment comes
last so it describes work already done rather than work merely intended; a delivery cut short
partway therefore leaves no comment claiming something that never happened. It states only what
the bot did, and never that a review has started, because every gate below it — an untrusted
target author, a PR the scan decides needs no re-review, an in-flight review — ends the run
cleanly and green.

When the bot declines a `recheck` it says so on the PR, so a requester can always tell the
command was read. It declines when the PR is merged, when it is closed, when it is a draft, when
the repo is not `pytorch/pytorch` — `greenlight-pr-review.yml` hard-codes that repo for both the
checkout and the verdict write, so a recheck dispatched from anywhere else would review an
unrelated PR of the same number — and when the requester is not a greenlight trusted author. The
bot enforces that last one itself, before it changes anything on the PR, because the scan's own
refusal is a clean green no-op that leaves no trace anywhere (see the authorization gates below);
without an up-front check in the bot, an untrusted requester would get no feedback at all.

Which form that answer takes depends on who is asking. Anything the bot posts as a comment
notifies every subscriber on the PR, so comments are reserved for commenters who already hold
write access on the repo; anyone else — and any unrecognized command — gets a reaction and nothing
more. Write access is the coarse gate and applies to every command, `help` included; the
trusted-author list is the narrow one, and only the narrow one decides whether a recheck runs.

Two filters run above all of that. The bot serves only a fixed set of orgs — an `@greenlight`
command anywhere else is ignored outright, with no answer of any kind — and within those, only the
repos its allowlist enables. Separately, a repeated `recheck` on the same PR inside a short
in-memory window is silently dropped rather than dispatched again, so a double-posted comment
cannot start two reviewer runs.

`--force` does exist, but only as a CLI flag (`greenlight review --pr N --force`, which
short-circuits `decision.decide` outright). It is deliberately not a `greenlight-review.yml`
input, so the recheck path cannot reach it — the same posture as `--allow-untrusted-author`. A
recheck is therefore decided by `decide` like any other scan, and `decide` dispatches on more than
a changed fingerprint: a PR never reviewed, a changed `eval_hash`, an in-flight marker older than
`--timeout-minutes`, or a `CANCELLED`/`FAILED` row past that same window. Only a PR whose recorded
verdict is terminal and whose `eval_hash` is unchanged is skipped — so rechecking a PR whose last
review was cancelled or failed does dispatch, unchanged or not.

Removing the `Stale` label is what keeps the PR under review afterwards, and it outlasts the
recheck. The `--pr` path already ignores the label — `_candidate_numbers` reports no labels for a
single-PR target — but the listing scan skips a `Stale`-labeled PR whose recorded state is
terminal, so leaving the label on would drop the PR back out of the periodic scan the moment the
recheck's verdict lands. `pytorch/pytorch`'s stale bot (`.github/workflows/stale.yml`) runs hourly
off the same `updated_at` greenlight reads and never removes the label itself; it closes a
`Stale` PR outright after 30 further days without an update, and re-adds the label plus re-posts
its message on any unlabelled PR whose `updated_at` is older than 60 days.

The unlabel also reaches a bot greenlight does not control. `pull_request.unlabeled` is delivered
to the pytorch-bot App, where `torchci/lib/bot/checkLabelsBot.ts` posts "This PR needs a `release
notes:` label" on any `pytorch/pytorch` PR carrying neither a `release notes:` label nor
`topic: not user facing`. A PR untouched long enough to be labeled `Stale` is disproportionately
likely to be missing both, so a recheck often produces that second, unrelated comment. That is
`checkLabelsBot` behaving as designed, not a greenlight fault.

The scan enforces authorization independently of the bot, with two gates against the
trusted-author set (`review.TRUSTED_AUTHORS`), matched case-insensitively:

- **Target-author gate** — `--pr N` looks up PR `N`'s author and refuses (no fingerprint, no
  dispatch, no review) unless that author is trusted. Unlike the listing scan, `--pr` names an
  arbitrary PR, so this gate is what stops an arbitrary PR from being reviewed or approved on request.
- **Requester gate** — `--requester <login>`, when given, additionally requires `<login>` to be
  trusted; an untrusted requester is refused before any network work, and the requester is logged
  for audit.

The bot's own trusted-author check duplicates the requester gate on purpose. The gate here stays
the enforcing one, because a `greenlight-review.yml` dispatch can arrive without passing through
the bot at all — run by hand, or from anything else holding the App's `actions: write`.

A refusal is a clean no-op (exit 0), not a failure. `--allow-untrusted-author` is a **local-only**
flag that skips the target-author gate for iteration; it is deliberately not exposed as a
`greenlight-review.yml` input, is unreachable from the comment/dispatch path, and never affects the
requester gate.

The recheck path treats an existing human decision differently from the listing scan. An existing
approval is ignored — greenlight reviews anyway, since a human approval may not authorize landing
for the PR's paths and the author may still want the bot's verdict. If the PR has a
changes-requested review, greenlight does not review; it posts a single comment that it will not
re-review while a reviewer's requested changes stand, and reconsiders once the reviewer dismisses
or resolves that review (not merely on the next push).

The status surface — Dr. CI's Green Light section on `pytorch/pytorch`, greenlight's own comment
elsewhere (see "Who posts the status comment") — carries no `@greenlight recheck` hint, so the
command is not discoverable from the PR itself.

### Recording a verdict

A privileged CI job records a review verdict with `verdict`. It runs once (never a
daemon): it emits a gzipped single-line JSON row (whose `reason` must be a canonical
`ALLOWED_REASONS` code) that the record workflow uploads to
`s3://gha-artifacts/greenlight_pr_state/`, where the clickhouse-replicator-s3 path ingests
it into `misc.greenlight_pr_state` — the command never writes ClickHouse directly. Then,
for `LAND`/`NO_LAND`, it acts on the PR (`LAND` approves; `NO_LAND` dismisses greenlight's
own prior approval). `CANCELLED` and `FAILED` markers only emit the row. The
model's message is secret-scrubbed at a single point before it fans out to both the emitted
row and the posted comment; whichever comment ultimately carries it — greenlight's own, or
Dr. CI's Green Light section rendered from the row — additionally defangs it to neutralize
formatting and @-mentions.

```bash
just run verdict --pr 123 --head-sha "$SHA" --verdict-file verdict.json \
  --eval-hash "$EVAL_HASH" --bot-login 'greenlight-app[bot]'   # LAND/NO_LAND
just run verdict --pr 123 --head-sha "$SHA" --status CANCELLED  # marker: emit row only
just run verdict --pr 123 --head-sha "$SHA" --verdict-file verdict.json \
  --eval-hash "$EVAL_HASH" --dry-run                            # offline; logs only
```

### Who posts the status comment

Every status the `verdict` command records — reviewing, did-not-complete, LAND, NO_LAND —
goes into one canonical greenlight comment, upserted in place, unless Dr. CI is showing that
state instead. Delegating it to Dr. CI takes one condition: the repo must be in
`constants.DRCI_STATUS_COMMENT_REPOS` (today only `pytorch/pytorch`). Then the upsert is skipped
entirely, because Dr. CI already renders the same state from the emitted row inside its own
comment and two comments saying the same thing is worse than one. The `LAND` approving review
and the `NO_LAND` dismissal are the merge gate and are unaffected on every repo. Only the status
comment is delegated: the scan's `@greenlight recheck` refusal (its own marker, see "Rechecking
a PR") is still posted by greenlight on every repo, `pytorch/pytorch` included.

The two surfaces are wired by separate allowlists that must agree: greenlight suppresses on
`constants.DRCI_STATUS_COMMENT_REPOS`, and the HUD renders on `GREENLIGHT_REPOS`
(`torchci/lib/greenlight/greenlightConfig.ts`). A repo in the first but not the second is
auto-approved by the merge gate with its status shown nowhere, so add and remove repos in both
at once; `greenlight/tests/test_render_sync.py` fails when the two lists drift apart.

Delegating also widens what the PR shows, because Dr. CI renders from the state row rather than
from the `verdict` command's calls. Two states that never had a comment surface now get one:
`AI_REVIEW_DISPATCHED`, written straight to S3 by the scan the moment it dispatches, and an
`AI_REVIEW_STARTED` row older than the in-flight window, which renders as "did not complete"
with reason `stalled` instead of claiming a review is still running.

Dr. CI otherwise rebuilds that comment only on a 15-minute sweep, and its probot handler
blanks the results section on every push — so a just-pushed or just-reviewed PR would show
nothing for up to a quarter of an hour. The `drci-poke` subcommand closes that window by
asking the endpoint to rebuild one PR's comment now:

```bash
PYTORCH_GREENLIGHT_DRCI_TOKEN="$DRCI_BOT_KEY" just run drci-poke --pr 123
```

It waits `PYTORCH_GREENLIGHT_DRCI_POKE_DELAY_SECONDS` (default 10) first, because Dr. CI reads
the state from ClickHouse and the row has only just been handed to the S3 -> replicator path.
It swallows every failure: by the time it runs the merge gate has already fired and the row is uploaded,
so failing would only turn the job that gates auto-landing red over a cosmetic refresh — and
the sweep still backstops a lost poke. The reviewer workflow runs it from both the
`announce_start` and `record` jobs, right after each uploads its row, with
`continue-on-error: true`. The scan pokes for its own `AI_REVIEW_DISPATCHED` row too, calling
`drci_poke.poke` in-process after each successful marker emit — with the delay forced to zero,
because that delay covers the reviewer workflow's gap between writing the row to `/tmp` and a
later step uploading it, whereas the scan has already put the object to S3 before it pokes.
A failed emit is not poked: rebuilding the comment then would only re-render the state the
marker was meant to replace.

The command writes the gzipped row to `/tmp/greenlight-verdict-row.json.gz` and its
bucket-relative key to `/tmp/greenlight-verdict-key.txt`; the workflow `aws s3 cp`s the
former to the latter. There is no direct ClickHouse write, so no `CLICKHOUSE_*` credentials
are needed here; `verdict` needs `PYTORCH_GREENLIGHT_GITHUB_TOKEN` to post `LAND`/`NO_LAND`,
and `--dry-run` needs nothing. `--bot-login` (the greenlight GitHub App's `<slug>[bot]`
account) is required for `NO_LAND`.

Configuration is read from the environment via `PYTORCH_GREENLIGHT_*` variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PYTORCH_GREENLIGHT_GITHUB_TOKEN` | unset | GitHub token used by `review` and `verdict`; `review` needs Actions: write (`workflow_dispatch`) on `pytorch/test-infra`, PR read on `pytorch/pytorch`, and org Members: read (`read:org`) to expand `merge_rules.yaml` team refs |
| `PYTORCH_GREENLIGHT_INTERVAL_SECONDS` | `60` | Seconds between iterations in `--loop` mode |
| `PYTORCH_GREENLIGHT_LOG_LEVEL` | `INFO` | Logging level (e.g. `INFO`, `DEBUG`) |
| `PYTORCH_GREENLIGHT_LOCK_PATH` | unset | Lock file path guarding against concurrent runs (unset = no lock) |
| `PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS` | `600` | Per-iteration hard cap on runtime (`0` = disabled) |
| `PYTORCH_GREENLIGHT_BACKOFF_BASE_SECONDS` | `1` | Base backoff after a failed iteration (daemon mode) |
| `PYTORCH_GREENLIGHT_BACKOFF_MAX_SECONDS` | `60` | Maximum backoff between retries (daemon mode) |
| `PYTORCH_GREENLIGHT_MERGE_RULES_TTL_SECONDS` | `600` | How long a resolved `merge_rules.yaml` authorized-login set is cached before refetch |
| `PYTORCH_GREENLIGHT_REVIEW_WINDOW_HOURS` | `24` | `review` skips a PR whose `updated_at` is older than this many hours, unless it has an in-flight or retry-eligible (cancelled/failed) review to re-check |
| `PYTORCH_GREENLIGHT_DRCI_POKE_DELAY_SECONDS` | `10` | How long `drci-poke` waits for the emitted row to reach ClickHouse before requesting the rebuild (`0` = no wait). Does not apply to `review`'s own dispatch poke, which always waits zero |
| `PYTORCH_GREENLIGHT_DRCI_TOKEN` | unset | Dr. CI endpoint key used by `drci-poke` and by `review`'s dispatch poke, sent as a raw `Authorization` value (the `DRCI_BOT_KEY` secret); unset skips the poke |
| `PYTORCH_GREENLIGHT_DRCI_INTERNAL_TOKEN` | unset | Optional `x-hud-internal-bot` header value for either poke (the `HUD_API_TOKEN` secret). Not an endpoint credential — Dr. CI authenticates on `Authorization` alone; this clears HUD's bot challenge, the same pairing `update-drci-comments.yml` already sends |

`review` additionally reads ClickHouse — any scan that finds at least one trusted-author
PR looks up `misc.greenlight_pr_state` — via the standard `CLICKHOUSE_*` connection
variables (`CLICKHOUSE_HOST` or its `CLICKHOUSE_ENDPOINT` alias, `CLICKHOUSE_USERNAME`,
`CLICKHOUSE_PASSWORD`, and `CLICKHOUSE_PORT`, default `8443`).

`PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS` (default `600`, `0` = disabled) bounds every
iteration in both one-shot and `--loop` mode, the scan's in-process Dr. CI pokes included —
those swallow their own failures but let the timeout through. In `--loop` mode, SIGTERM/SIGINT
are observed only between iterations, so the per-iteration timeout is what interrupts a
hung run.

## Deployment

In production the scheduled scan runs as an AWS Lambda, `greenlight-scan`, in the
`pytorch-gha-infra-2` account (`us-east-1`), triggered by an EventBridge `rate(5 minutes)`
schedule. The function runs `python3.13` with handler `greenlight.lambda_handler.handler`, a
300 s timeout, and `reserved_concurrent_executions = 1`. It runs the same one-shot
`execute_once` / `review.run` path as `greenlight review` — no scan-logic change — after minting a
least-privilege GitHub App installation token in-process and reading the App PEM and ClickHouse
password from AWS Secrets Manager (`pytorch-greenlight-secrets`) at runtime. The handler sets
`PYTORCH_GREENLIGHT_MAX_RUNTIME_SECONDS=0`, so it runs with no single-instance lock and both
hang-guard layers off (the SIGALRM soft timeout and the `os._exit` hard watchdog, which is wrong
under the Lambda runtime); single-instance and hang-bounding come from
`reserved_concurrent_executions = 1` and the Lambda function timeout instead.

The scan's Dr. CI poke needs `PYTORCH_GREENLIGHT_DRCI_TOKEN` (and optionally
`PYTORCH_GREENLIGHT_DRCI_INTERNAL_TOKEN`) wherever the scan runs: the Lambda reads both from its
function environment, provisioned by the gha-infra terraform, and the `@greenlight recheck` entry
point (`greenlight-review.yml`, dispatched by the greenlight Probot bot or run by hand) passes
them from the `DRCI_BOT_KEY` and `HUD_API_TOKEN` secrets. Without the token every poke logs a
warning and no-ops, leaving the `AI_REVIEW_DISPATCHED` state to surface on Dr. CI's 15-minute
sweep — the scan itself still succeeds.

The zip ships in test-infra's shared lambda release alongside every other lambda:

1. `just package` builds `dist/greenlight-scan.zip` (linux x86_64 / cp313 wheels); the
   `build-greenlight-lambda` job in `_lambda-do-release-runners.yml` runs the same recipe.
2. Any push to `main` touching `greenlight/**` makes `lambda-release-tag-runners.yml` cut a
   `v<timestamp>` tag, which publishes one GitHub Release carrying `greenlight-scan.zip` next to
   the other lambda zips. `workflow_dispatch` on that workflow cuts a release on demand.
3. An operator pins that release tag in `pytorch-gha-infra-2`'s `runners/common/Terrafile` (the
   `greenlight-scan` entry).
4. `terraform apply` in `runners/regions/us-east-1` rolls it out.

The greenlight build leg is `continue-on-error`, so a broken package step omits
`greenlight-scan.zip` from the release rather than blocking the other lambdas — check that the
asset is present before pinning a tag.

## Reviewer checkout sanitizing

The reviewer workflow (`greenlight-pr-review.yml`) checks the PR's `pytorch/pytorch` tree
out under `./pytorch`, which is untrusted: a PR could plant AI-assistant instruction files
that Claude Code auto-loads as steering — its own `CLAUDE.md`, `CLAUDE.local.md`, and
`.claude/rules`, plus defense-in-depth `AGENTS.md`, `.cursorrules`, and
`.github/copilot-instructions.md` — and thereby override the reviewer's task. Two layers,
both before the model runs and neither ever `continue-on-error`, close this off:

- **Sanitize, restore skills only** — `sanitize-untrusted-checkout.sh` strips every such
  instruction file from `./pytorch`, then restores only `.claude/skills/` from a separate
  sparse checkout of trusted pytorch `main`. The model then runs with none of the PR's
  steering loadable, so it judges pytorch PRs code-only and does not auto-load pytorch's own
  `CLAUDE.md` conventions as context. A PR's edits to these files still appear in the reviewed
  diff (`/tmp/greenlight-pr.diff`, produced by `gh api` compare) and are reviewed as data. The
  forbidden-name set is single-sourced in the script and must be re-verified on any
  `claude-code-action` / Claude Code CLI bump (last verified CLI 2.1.169 / action v1.0.141).
- **Deny-root runtime detector** — `assert-loaded-instructions.py` reads the manifest an
  `InstructionsLoaded` hook records plus a `SessionStart` sentinel, and fails the review job
  if any instruction file loaded from under `./pytorch`, or if the hooks never ran. It runs
  `if: always()` before any verdict handoff, so a poisoned-but-successful model run is still
  caught; because `record` gates LAND/NO_LAND on `review` success, a failed review records
  only a FAILED marker, never a LAND.

Both scripts live at `.claude/hooks/greenlight/`, alongside the reviewer's existing
`restrict-read.py` (read-path guard), `restrict-write.sh` (write-path guard), and
`validate-on-stop.sh` (verdict-schema guard).

The detector depends on the hooks firing, so the first live dispatch must confirm the
`SessionStart` and `InstructionsLoaded` hooks actually fire under the pinned
`claude-code-action` — the detector fails closed if they do not, surfacing a misfire as a
failed review rather than a silent gap.

Two further controls narrow the residual data-exfiltration gap — a data-injection payload in
the diff or tree coaxing the model to read a credential and emit it in the verdict — though
both are best-effort defense-in-depth, not guarantees:

- **Read confinement** — a `restrict-read.py` PreToolUse hook confines the model's
  `Read`/`Glob`/`Grep` by `os.path.realpath` to `./pytorch`, the trusted `.claude/skills` and
  `.claude/hooks`, and the `/tmp/greenlight-*` scratch files, denying everything else (the OIDC
  credentials under `/proc`, the `$GITHUB_ENV` file, `./pytorch/.git`). `persist-credentials: false`
  on the `./pytorch` checkout additionally keeps the scoped token out of `./pytorch/.git/config`.
- **Message scrubbing** — the verdict `message` is secret-scrubbed at a single fan-out point
  before it reaches both the posted comment and the `misc.greenlight_pr_state` row, so a message
  Dr. CI later renders back out of that row is scrubbed too (either comment additionally defangs
  it for formatting and @-mentions). Nothing bypasses the scrub by being long: text past the input
  cap is dropped rather than left unread, and the cap retreats to a whitespace boundary — the one
  cut point that cannot fall inside a credential value — so the run it would otherwise sever is
  redacted whole. A message with no whitespace to retreat to keeps its run minus any
  credential-shaped tail.

An oversized diff is also declined before the model runs: the reviewer gates on line count (the
model's ~2000-line read window) with a byte-size backstop, emitting a `scope_too_large` NO_LAND
rather than reviewing a change it cannot read in full.

## Current status

Works today: the CLI runs the `review` phase once (cron-like) or as a `--loop` daemon,
with a single-instance lock, a per-iteration soft timeout plus a hard watchdog, backoff
on failure, and clean signal shutdown — all built and tested. `review` scans the open PRs
from a fixed set of trusted authors in `pytorch/pytorch`, computes each PR's fingerprint
(`eval_hash`), reads the PR's latest recorded state from `misc.greenlight_pr_state`, and
dispatches the reviewer workflow (`greenlight-pr-review.yml` on `pytorch/test-infra`) for
PRs that are new or changed. Draft PRs are dropped from the listing scan entirely — never
fingerprinted or dispatched; the drop is in the listing fetch alone, so `--pr N` reviews a
draft, but the bot turns a draft down rather than dispatching one. PRs whose `updated_at` is
older than the review window
(`PYTORCH_GREENLIGHT_REVIEW_WINDOW_HOURS`, default 24), or that carry the `Stale` label, are
skipped without fingerprinting unless a review is in-flight or retry-eligible (cancelled/failed);
an explicit `@greenlight recheck` (the `--pr` path) reviews such a PR regardless. PRs a human has already decided
— approved by a merge-authorized login (bots excluded) or with changes requested by any non-bot
reviewer — are also skipped without fingerprinting, and no state is written, so the scan resumes
if that changes. An `AI_REVIEW_STARTED` marker is treated as an
in-flight review and left alone until the `--timeout-minutes` window (default 45) elapses.
`review` requires `PYTORCH_GREENLIGHT_GITHUB_TOKEN`, and any scan with at least one PR reads
ClickHouse (`CLICKHOUSE_*`).

Also works: the reviewer workflow's `announce_start` job emits the `AI_REVIEW_STARTED`
marker at run start; the `verdict` subcommand emits a PR-review verdict row (with the
passed-in `eval_hash` verbatim) for the record workflow to upload to
`s3://gha-artifacts/greenlight_pr_state/`, where the clickhouse-replicator-s3 path ingests
it into `misc.greenlight_pr_state`; for LAND/NO_LAND it also acts on the PR — approve, or
dismiss greenlight's prior approval. `verdict` is a one-shot call for a
privileged CI job and never writes ClickHouse directly. The `drci-poke` subcommand asks Dr. CI
to rebuild one PR's comment, which is where the status is shown on the repos that delegate it.
The service reads ClickHouse via `clickhouse_client.connect()` for both the review scan and its
other SELECTs.

`misc.greenlight_pr_state` is append-only-equivalent: it keeps its `SharedReplacingMergeTree`
engine, but no verdict emit is ever collapsed because the sort key
`(repo, pr_number, run_id, emit_id)` ends in a per-emit UUID (`emit_id`) that no two rows
share. greenlight picks the authoritative row per PR at read time by highest `run_id`, then
latest `version` (`state.read_latest_states`). Ordering by `run_id` before `version` is
race-proof — a superseded slower dispatch that finishes with a later `version` still loses to
the newer dispatch's higher `run_id`. Each emitted row carries those `run_id` and `emit_id`
columns, added by a single in-place `ALTER` (`greenlight/sql/004`) that also extends the sort
key — no new table, backfill, or `EXCHANGE`. At go-live that DDL and the
clickhouse-replicator-s3 Lambda adapter must land together, since a schema skew between them
drops rows.

Not built yet: only the land-time verifier — the pytorchbot side that reads
`misc.greenlight_pr_state` back at land time. The review-side scan, fingerprint, state
read, and dispatch are all wired; nothing consumes the recorded state at land time yet.

When wired, the land-time verifier must look up stored state by `(repo, pr_number)`
— the ledger's `ORDER BY` key — never by `eval_hash` alone: the fingerprint omits
repo and PR number, so a hash-only lookup would let one PR's approval replay onto a
different PR. The writer (greenlight) and the verifier (pytorchbot) run the identical
`pr_hash` / `build_pr_fingerprint` code and upgrade hash schemes together.

The fingerprint also covers only comments authored by `pytorch/pytorch`'s
merge-authorized set — every `approved_by` login in `.github/merge_rules.yaml`, with team
refs expanded to members (see `merge_authz`). The land-time verifier MUST resolve that same
set the same way — via `merge_authz.resolve_authorized_logins`, which lowercases every login
and unions *all* `merge_rules.yaml` entries — and MUST NOT reuse pytorch's `trymerge.py`
authorization check, which is case-sensitive and scoped to the rules whose file patterns
match a single PR. A divergent set computes a different digest and refuses every land. A
login entering or leaving the set re-fingerprints only the PRs where that login has
commented.

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
  cli.py           # CLI parsing (review + verdict + drci-poke subcommands), dispatch, exit codes
  lambda_handler.py # AWS Lambda entry point: load secrets, mint App token, run one review scan via cli.main
  runner.py        # run_forever(): resilient daemon loop; execute_once(): one-shot phase run
  review.py        # scan trusted-author PRs: fingerprint, read state, dispatch reviewer workflow for new/changed; raises on failure
  state.py         # read a PR's latest recorded state from misc.greenlight_pr_state
  decision.py      # decide which scanned PRs need a (re-)dispatch (new/changed vs. in-flight AI_REVIEW_STARTED)
  dispatch.py      # trigger the reviewer workflow on pytorch/test-infra via workflow_dispatch
  verdict.py       # one-shot: emit a verdict row for S3->replicator, then approve/dismiss and (unless Dr. CI renders it) comment
  drci_poke.py     # ask Dr. CI to rebuild one PR's comment (drci-poke subcommand and the scan's dispatch poke); swallows its own failures
  github_client.py # GitHub PR access: read PR list/fingerprint + post verdict actions
  clickhouse_client.py # ClickHouse connection helper for the service's read (SELECT) queries
  pr_hash.py       # eval_hash land-guard: deterministic PR fingerprint hash
  config.py        # PYTORCH_GREENLIGHT_* environment configuration
  constants.py     # shared constants for the review scan/dispatch flow
  guards.py        # single-instance lock + per-iteration SIGALRM timeout + hard watchdog
  log.py           # logging setup
  exit_codes.py    # process exit codes
tests/             # unit tests mirroring the modules above
```
