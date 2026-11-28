# The scan Lambda (`greenlight-scan`)

The scheduled scan runs as one AWS Lambda function with two roles, chosen by its event
(`lambda_handler.py`):

- the EventBridge schedule (`rate(2 minutes)`, one **tick**) runs the **planner** (`fanout.py`);
- a worker event (`{"greenlight_worker": {"repo", "tick", "dispatch_cap"}}`) runs that repo's
  **worker** (`worker.py`), invoked asynchronously by the planner. A worker event naming
  `pytorch/pytorch`, whose run is the planner's, is refused.

Any other event is refused before anything is read. Both roles read the GitHub App key and the
ClickHouse password from Secrets Manager, mint their own App tokens, resolve the App's
`<slug>[bot]` login, and keep their shared state in the DynamoDB table
`PYTORCH_GREENLIGHT_STATE_TABLE`. Neither arms the CLI's hang guards: the function timeout (300 s)
is the backstop.

The CLI's `review --repo` (and `greenlight-review.yml`, which runs it) scans one repo once with an
in-process store, reading its config through the same config cache, and takes no lease. What each
repo's config does is in [REPOS.md](REPOS.md).

## The planner

Each tick, in this order:

1. It reads the shared rate-limit latch.
2. `pytorch/pytorch` first: it mints its repo token and the dispatch token, takes its lease, reads
   its stored item, revalidates its config, and runs its **Phase A** (below) right there, whatever
   the latch says, so its safety work never waits on a worker.
3. It reads the shared latch again, then lists the repos the App installation reaches
   (`GET /installation/repositories`), mints `contents: read` tokens for the public, unarchived
   ones, and for every listed or stored repo but `pytorch/pytorch`, the one whose config read was
   last tried longest ago first (so a repo whose read keeps failing or hanging goes behind the
   others), revalidates its config through the config cache, decides its settings,
   checks the listing's report of it (the exact canonical name, public, not archived, default
   branch `main`), and stores the updated config record before any worker can read it. A private or
   archived repo's file is not read; one with no stored config is only reported.
4. It invokes one worker per repo with work and a free lease, the repos whose last completed run is
   oldest first, at most `PYTORCH_GREENLIGHT_MAX_WORKERS` running at once, counting the workers
   still running from earlier ticks. An `off` repo whose drain is complete has no work.
5. `pytorch/pytorch`'s **Phase B**, then its memory is saved under its lease with the tick, and the
   lease released.
6. One outcome line per repo, the shared latch extended by any rate limit this invocation met, and
   one error naming every problem, which fails the invocation.

Step 3 starts no repo's config read `FANOUT_BUDGET` (45 s) after the fan-out started, so its
discovery never eats into `pytorch/pytorch`'s Phase B, whose deadline stays `WORKER_DEADLINE` after
the invocation started; step 4 still invokes every repo step 3 planned, since an invoke is a cheap
asynchronous call. The repos not read are `deferred`, and the next tick reads them before the ones
read this tick; a deferred repo whose stored record says it has work is still held to the stale-run
check (below). Steps 3 and 4 are skipped when the store failed, the shared latch holds (at the
start or when read again in step 3) or cannot be read again, or this invocation met a rate limit;
step 5 then is too. Step 5 is
also held back when the installation listing does not list `pytorch/pytorch` or its report of it
fails a check. A listing that fails skips every other repo for the tick.

## The worker

A worker takes its repo's lease (ending, logged, when another invocation holds it), reads the
repo's item and ends when that tick already completed (a replayed invocation), ends when the shared
latch holds, derives its settings from the config record the planner stored (the planner's own
decision, so both agree) and ends when they give no work. Otherwise it mints the repo token and the
dispatch token and reads `GET /repos/{repo}` with the repo token: a repo that fails a live check
since the planner read the listing (renamed, turned private, archived, its default branch changed)
gets no work, and its problem fails the worker. Then it runs Phase A then Phase B, its dispatch cap
the event's clamped to `OTHER_REPO_MAX_DISPATCHES` and 0 while the handler's
`PYTORCH_GREENLIGHT_MAX_DISPATCHES_PER_SCAN` is 0, saves the memory with the completed tick under
its lease, extends the shared latch by any rate limit it met, releases the lease, and raises when
the repo had errors. A store failure fails it before any GitHub work. The planner's asynchronous
invokes are not retried (0 retries, 60 s maximum event age on the function): a worker that fails or
never starts waits for the next tick's plan.

## Phases

`tick.RepoRun` routes a repo by `repo_scan.repo_work`:

- **Phase A, safety work**, never stopped by a budget or a quota floor: an `off` repo runs its
  drain slice, a `pytorchbot` repo lists its PRs and runs the revert guard and the ineligible
  revoke (`review.prepare`; a `clickhouse` repo's listing reads HUD ClickHouse first), a `gate`
  repo that is not `off` its approval-backing check ([GATE.md](GATE.md)), which starts no read
  `BACKING_DEADLINE` (120 s) after its invocation started and whose report errors are the repo's; an
  `active` gate repo whose gate is not enforced, or whose rules could not be read, runs no Phase B. A
  safety-only repo stops here; a safety-only `gate` repo gets a worker (dispatch cap 0) for its check.
- **Phase B, optional work**: `review.prepare` (unless Phase A ran it) and `review_finish.finish`
  (fingerprint fan-out, dispatch, label pass). It starts no GitHub request 240 s after its
  invocation started (`WORKER_DEADLINE`), nor below `QUOTA_FLOOR_PRIMARY` (1000) requests left on
  the installation for `pytorch/pytorch` and `QUOTA_FLOOR_OTHERS` (3000) for the others, and a repo
  other than `pytorch/pytorch` stops once its Phase B spent `OTHER_REPO_REQUEST_BUDGET` (400)
  requests.

A Phase B cut short is the repo's error when its full tick was due, and a warning on a fast tick,
its PRs waiting for the next one. A repo with optional work marks its full tick done only when its
Phase B's listing, fingerprint fan-out and dispatch finished without a stop (a cut or a rate limit;
a PR whose dispatch failed on its own does not count): a Phase B cut short or held back (the latch,
a listing refusal, no dispatch token) leaves it due, so it shows every tick until it fits. A Phase B
that returns with the latch set is a rate-limit stop. A safety-only repo marks it when its safety
work met no rate limit. A stopped fan-out keeps the fingerprint results it already stored and the
earlier ones of the PRs it never looked up. The PRs its Phase B failed on before a cut or a
rate limit stopped it are always its error. Without the dispatch token (its mint failed) a repo runs
Phase A only, and the failed mint is its error.

## Leases

Every Lambda scan of a repo holds that repo's lease: a conditional write on its store item that
succeeds only when no lease is there or the one there has expired. A lease lasts
`LEASE_DURATION` (330 s), longer than the 300 s function timeout, so it is never taken over while
its holder can still run; an invocation killed by the timeout frees it at expiry. Memory saves are
conditioned on the saver holding an unexpired lease, and a release clears the lease only for its
owner. Every expiry is checked against the caller's clock, never left to the table's TTL. So no two
invocations ever work the same repo, or the same PR, at once: a planner that finds
`pytorch/pytorch`'s lease held (an earlier planner still runs it) runs nothing for it and fails.

Only Lambda invocations take leases. `greenlight-review.yml` and the reviewer workflow's record job
take none, and their overlap with a Lambda scan stays harmless: a second dispatch of a PR cancels
the review run of the first (the reviewer workflow's concurrency group), the scan treats a PR with
an in-flight dispatch as busy until its timeout, approval dismissals and label writes are
idempotent, and the record job checks the author's eligibility live before it approves.

## The state store

`state_store.py` defines the store; `state_dynamo.py` is its DynamoDB backend, and the CLI uses an
in-process one with the same semantics. Items are keyed by the string attribute `pk`:

- `repo#<repo>`: the repo's lease (`lease_owner`, `lease_expires`); its scan memory (`memory`:
  when its last full and wide ticks that completed started, the fingerprint results later ticks
  reuse, its drain's progress, on a `clickhouse` repo its view of its open PRs with their
  markers ([CHANGE_DETECTION.md](CHANGE_DETECTION.md)), and on a `gate` repo its approval-backing
  memory (an optional key with its own version, never dropped, cleared while the repo does not back
  approvals), compressed; a memory over 300 KB is saved
  without its fingerprint results, then without its view too; a memory stored by the release before
  is read forward without a view, and one of any other version starts cold); the last tick a run completed and when (`last_tick`,
  `last_completed_at`); whether its drain is complete (`drain_complete`); and its config cache
  (`cfg_*`: the last file read with its ETag and size, when it was last read or revalidated, why
  the last read was not a usable file, the last valid text, when a read was last tried, plus
  `served`, `work_since` and `reported`).
- `eligibility#<repo>#<eligibility>#<minimum_role>`: the repo's eligibility snapshot (its merge
  rules, or its minimum role's holders) and when it was fetched, refetched once older than
  `PYTORCH_GREENLIGHT_MERGE_RULES_TTL_SECONDS` (600 s); a transient failure serves it for at most
  three TTLs.
- `ratelimit`: until when the installation's quota is latched, with a TTL (`ttl_at`); repo items
  carry none, since a TTL there would delete their memory and config cache with the lease.

Every write is one `UpdateItem` touching only its own attributes, so the planner's config writes
and a worker's memory and lease never clobber each other; reads are consistent. The function needs
`dynamodb:GetItem`, `dynamodb:UpdateItem` and `dynamodb:Scan` on the table, and
`lambda:InvokeFunction` on itself. Tokens and the App key are never stored.

**Store errors.** A failure reading the latch when the planner starts, taking `pytorch/pytorch`'s
lease or reading its item leaves the planner running its Phase A on a cold memory, skipping its
Phase B and the fan-out, saving no memory (a lease taken is still released) and failing; a later
failed read of the latch stops the invocation's optional work and the other repos' work as a latch
that holds would, and fails the invocation; a failure publishing the latch is only logged. A failure
listing the stored repos
skips the fan-out; one storing a repo's config record gives that repo no worker this tick; one
saving a memory, or a lease lost before the save, is the repo's error. An eligibility snapshot that
cannot be loaded is fetched instead.

## The config cache

`config_cache.revalidate` reads `.github/greenlight/config.yml` from the repo's default branch with
`If-None-Match` on the stored ETag, so an unchanged file costs a 304 and no quota. A file found
absent (a 404) is asked again only `CONFIG_ABSENT_TTL` (600 s) later, so a new file is picked up
within about ten minutes. A directory, a file over 8192 bytes, or one that is not UTF-8 text, is
invalid; any other failed read keeps the stored record, but for when a read was last tried, and
says why (unreadable); a rate limit,
judged as PyGithub judges one (its status, headers and body, so a 403 saying "secondary rate limit"
counts), sets the latch. The CLI's scan reads through the same `revalidate` and `decide` over its
in-process store.

`config_cache.decide` applies [REPOS.md](REPOS.md)'s rules to the last file read, and these on top:

- an invalid file is safety-only under the repo's last valid settings, when it had any;
- an unreadable file serves the last file read, with the failure as a problem;
- a repo other than `pytorch/pytorch` whose file is removed while it is served runs as `off`, its
  drain, until the drain completes, a problem until then; then it is no longer served;
- `pytorch/pytorch`'s file absent after a valid one is safety-only under its last valid settings:
  it never goes back to the built-in entry's `active` mode;
- a repo the installation no longer reaches gets no work; while it was served and its drain not
  complete, that is a problem on every tick, since its approvals cannot be drained.

A config problem of a repo other than `pytorch/pytorch` fails the planner on the tick it first
appears or changes, and is a warning after that; the unreachable one, and any of
`pytorch/pytorch`'s, fails every tick.

## Budgets, quota and rate limits

Every GitHub client of a repo shares one request meter (`quota.py`) that counts each request
PyGithub sends and each retry urllib3 makes, the config read and the installation listing included;
the quota reads, the token mints and PyGithub's rare 301, 302 and 202 follow-ups are not counted.
Each invocation reads the installation's quota (`GET /rate_limit`, which costs nothing) when it
starts, before each phase with work, after each run, and again every `QUOTA_REFRESH_REQUESTS` (25)
of its own requests, never once its latch is set, so its floors see what the other invocations
spent meanwhile. Each run logs
its Phase A and Phase B requests with the quota at the invocation's start and the run's end.

The quota belongs to the App installation, shared by every invocation and by the review workflows.
A rate limit anywhere (a response, a token mint, the listing, a quota read) sets the invocation's
latch, the meter setting it on a rate-limit response before any retry or `Retry-After` wait (the
one exception, `pytorch/pytorch`'s short 429, is below): every
meter then refuses further requests, the repos and phases left are skipped, and the invocation
fails naming the rate limit. A dispatch that hits one stops the dispatches and the label pass. The
latch holds until the time the response asked for (its reset at `x-ratelimit-remaining: 0`, else
`Retry-After`, else 60 s), never more than `RATE_LIMIT_LATCH_MAX` (15 minutes) ahead, the scan
code that catches a rate limit itself (the dispatch, the fingerprint fan-out, the label pass, the
revert guard, the revokes, the drain) keeping that wait too. The invocation publishes it to the
store's shared latch the moment it is set, and again when it ends. Every invocation reads the
shared latch at its start, again before each Phase B, before a dispatch and before the planner's
fan-out, and every `QUOTA_REFRESH_REQUESTS` (25) of its requests outside `pytorch/pytorch`'s Phase
A; a shared latch that holds sets its own. So a rate limit one invocation meets stops the others'
optional work and the other repos' work at their next request, never `pytorch/pytorch`'s Phase A. A
store failure on a later read of the shared latch stops them the same way (with no wait to publish)
and fails the invocation, naming the failure; one publishing it is logged, and the invocation goes
on with its own latch.

**Isolation.** `pytorch/pytorch` runs in the planner and every other repo in its own worker
invocation. Within one, a repo's stop is checked before each request and each retry, but cannot
interrupt a request already sent or a ClickHouse read (bounded by its own timeouts: connect 10 s,
read 60 s; a `clickhouse` repo's change-feed reads are abandoned after 20 s instead,
[CHANGE_DETECTION.md](CHANGE_DETECTION.md)). Any other failure in a step is logged with its traceback and becomes the repo's error.
Repos other than `pytorch/pytorch` read their eligibility with the fail-fast client.
`pytorch/pytorch`'s patient client waits out, in its Phase A only (which has no deadline), a 429
asking to wait no longer than its retry's cap (60 s), counted as a retry; any other rate limit, or
one that outlasts its retries, latches at once.

## Dispatch caps and concurrency

`pytorch/pytorch` dispatches at most `PYTORCH_GREENLIGHT_MAX_DISPATCHES_PER_SCAN` (30) per tick.
The other repos share `OTHERS_DISPATCH_POOL` (10) per tick: each worker invoked in a tick gets an
equal share, at least one and at most `OTHER_REPO_MAX_DISPATCHES` (5). A cap of 0 pauses every
repo's dispatches, in the workers already queued too, which read it when they start; the scans still
run their safety work and label passes.

`PYTORCH_GREENLIGHT_MAX_WORKERS` (default 3) bounds the workers running at once. More repos with
work than that fails the planner every tick until it is raised. The function's
`reserved_concurrent_executions` is `MAX_WORKERS + 2`: the workers, the planner, and one planner
that outlives its two-minute tick. An asynchronous invocation past the reservation is throttled,
waits at most the 60 s event age, and is then dropped; the next tick plans again. The arithmetic that sizes it:

- **Dispatches**: at most `30 + max(10, MAX_WORKERS)` per tick (48 at 18 workers), under GitHub's
  80 content-generating requests per minute. GitHub also allows 500 an hour, which the caps alone
  do not bound: that takes a steady stream of changed PRs.
- **Token mints**: the planner mints at most four a tick (the `pytorch/pytorch` and dispatch
  tokens, the listing token, one contents token per 500 repos) and each worker two, so
  `4 + 2 × MAX_WORKERS` a tick, 1,200 an hour at 18, against GitHub's 2,000 token requests an hour
  for the App. Each dispatched review mints two more in its own workflow.

## Outcomes and alerts

The planner logs one line per repo, `greenlight repo outcome: <repo> <outcome> [<detail>]`, at INFO
without a detail and WARNING with one. The outcomes are `served`, `safety-only`, `draining`,
`drained` (an `off` repo whose drain is complete: no worker), `invoked` (a worker was started),
`busy` (its lease is held), `deferred` (the fan-out's budget ran out before its read), `cut`,
`skipped`, `failed`, `refused`, `absent` and `unreachable`. `pytorch/pytorch`'s says what its Phase B
did: `served` when it ran, `cut` when a stop or a rate limit cut it short, `failed`, or
`safety-only` with why it did not run. A repo with work, or a deferred one whose stored record says
it has work, whose last completed run and the start of its current run of ticks with work are both
older than `STALE_RUN_TICKS` (3) ticks fails the planner: its workers are not finishing, or it is not
reached. Every failed invocation, planner or worker, shows in the function's error
metric, with its error naming each repo's problems.

## Environment

Beyond the variables the README lists for every path, the Lambda reads `SECRET_STORE_NAME`,
`GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, the `CLICKHOUSE_*` connection variables, and:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PYTORCH_GREENLIGHT_STATE_TABLE` | unset | The DynamoDB table of the state store; the handler refuses to run without it |
| `PYTORCH_GREENLIGHT_MAX_WORKERS` | `3` | How many workers run at once; keep `reserved_concurrent_executions` at this plus 2 |
| `PYTORCH_GREENLIGHT_MAX_DISPATCHES_PER_SCAN` | `30` | `pytorch/pytorch`'s dispatches per tick; `0` pauses every repo's dispatches |

## Rollout

1. Apply the infrastructure change: the state table (`pk` string key, TTL on `ttl_at`, on-demand
   billing, deletion protection), its IAM permissions (above), and the two environment variables.
   The running release ignores all three.
2. Merge the three PRs of the GreenLight multi-repo stack, bottom up.
3. Check that the release cut from the last merge carries `greenlight-scan.zip`.
4. Cut over in one infrastructure change: pin that release tag and raise
   `reserved_concurrent_executions` from 1 to `MAX_WORKERS + 2`. Roll both back together, never the
   tag alone: an older release relies on a concurrency of 1 for its single-flight.
5. Any time after step 2, land in `pytorch/pytorch` its own `.github/greenlight/config.yml`
   (`status_comment: drci`, `safety: pytorchbot`, `eligibility: merge_rules`, `mode: active`), a
   CODEOWNERS line protecting it, and a CI step running `greenlight check-config` on it. Its
   `change_source: clickhouse` line waits for a pinned release that knows the key and for the scan's
   ClickHouse access ([CHANGE_DETECTION.md](CHANGE_DETECTION.md), "Access").
6. Other `pytorch` repos opt in themselves ([REPOS.md](REPOS.md), "Opting a repo in"): a repo admin
   (or, where the org restricts that, a `pytorch` org admin) adds the repo to the App's `pytorch`
   installation, then the repo commits its file, in `mode: shadow` first.

Before rolling the Lambda back past a release that accepts `safety: gate` with `mode: active`, follow
GATE.md's "Leaving": every gate repo `off` and drained first.
