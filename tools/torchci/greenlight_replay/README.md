# greenlight_replay

Re-runs the greenlight reviewer over pull requests it has already judged, under
a policy that has not shipped yet, and writes the decision export back out with
four extra columns holding the new verdict. The question it answers is "what
would this policy pull request have said about these pull requests", one
judgement apiece, on the same head SHA greenlight judged at the time.

It answers that question and no other. **A row where `decision` and
`new_decision` disagree is a pull request to go read, not a measured policy
effect** — misreading 1 explains why, and no amount of sample size fixes it.

## Running

```bash
cd tools/torchci
pip install -r requirements.txt
pip install -e .

python3 -m torchci.greenlight_decisions --output /tmp/decisions.csv
python3 -m torchci.greenlight_replay \
  --input /tmp/decisions.csv --policy-pr 8830 --sample-n 30 --dry-run
```

Start with `--dry-run` every time. A real sweep of 30 pull requests costs around
$40 and runs for over an hour at the default parallelism.

The dry run makes every check a real run makes short of invoking a model, and
prints what it checked and what it did not. It confirms the scratch root is
usable, the binaries are on the reviewer's PATH and the policy ref exists on the
remote, then fetches the policy and checks it: the workflow parses, the diff caps
and canned verdict are readable, any stack step is a version the harness
recognises, the verdict schema uses only keywords the harness implements, every
hook script resolves, and the inference profile maps to a model. That costs a few
seconds and about 34 MB. Fetching twice is safe: materializing clears its
destination and re-extracts, so a dry run does not spoil the real run after it.

What it does not do is the per-run work: the blobless clone of the repo, the worktree
slots, and each pull request's diff, metadata and stack context. Those are
gigabytes and a few GitHub round trips per pull request, and nothing they could
tell you is a property of the policy. Everything that fails identically for every
pull request in the sweep is caught here.

Runtime requirements:

- `CLICKHOUSE_ENDPOINT`, `CLICKHOUSE_USERNAME`, `CLICKHOUSE_PASSWORD`. If your
  shell defines `CLICKHOUSE_HOST` instead, pass
  `CLICKHOUSE_ENDPOINT="$CLICKHOUSE_HOST"`. Behind a corporate proxy the
  ClickHouse TLS handshake may need that host excluded via `NO_PROXY`; whatever
  proxy variables are set are forwarded to the reviewer, which does need them.
- `gh`, authenticated, for the diff, the pull request metadata and the stack
  context: its GraphQL reads through `gh api graphql`, and each sibling's diff
  through a REST compare. `git` for the clones. `claude` and GNU `timeout` for the
  reviewer, whose `PATH` is pinned rather than inherited, so both must be
  reachable from `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`; the sweep checks
  this before it starts. On Bedrock, `AWS_REGION` and credentials in `~/.aws`.
- Disk: one blobless clone of the repo plus a worktree per `--parallelism`, a second
  sparse clone of the repo (its `.claude/skills` and `.github/greenlight`, at
  `--trusted-ref` or main) for the sanitize and staging steps, and the policy tree.
  Roughly 1.2-1.8 GB per policy pull request at the default parallelism, kept
  under `--workdir` and never cleaned up automatically.

Everything the tool does to GitHub and ClickHouse is read-only. It writes only
under `--workdir`, to `--output` and, run as `collect.py`, to `--answers`. In CI,
`collect.py` frames and samples once and records every GitHub read both policies
make; replay jobs run `--presampled` with `GREENLIGHT_REPLAY_GITHUB_ANSWERS`
naming that record, so they need neither ClickHouse nor an authenticated `gh`.

| flag | default | effect |
| --- | --- | --- |
| `--input` | required | the CSV from `python3 -m torchci.greenlight_decisions` |
| `--policy-pr` | — | test-infra pull request carrying the policy under test |
| `--policy-ref` | — | a git ref or full commit SHA instead (the fetch checks a SHA); exactly one of the two is required |
| `--sample-frac` | — | fraction of the framed rows to replay |
| `--sample-n` | — | absolute count, or with `--sample-frac` the most it draws; at least one is required |
| `--seed` | `0` | the same seed over the same frame draws the same sample |
| `--presampled` | off | the input already is a sample, such as `collect.py`'s `--output`: no frame, no sampling, every row replayed as written |
| `--parallelism` | `4` | concurrent reviewer runs |
| `--output` | `greenlight_replay_<timestamp>.csv` | destination; `.gitignore` covers `greenlight_replay_*.csv`, but one outside the checkout is tidier |
| `--workdir` | `/tmp/greenlight-replay` | scratch root; keep it under `/tmp/greenlight-*` |
| `--resume` | off | re-run only what has no verdict yet |
| `--timeout-minutes` | `37` | wall clock allowed per reviewer run |
| `--repo` | `pytorch/pytorch` | which repo the sampled pull requests belong to, `pytorch/<name>` only: it picks the clone, the slot's checkout directory (`pytorch` for pytorch/pytorch, `target` otherwise, as in CI), the trusted tree, the prompt's repo, `restrict-read.py`'s argument and the repo policy staged into the slots (see [WORKSPACE.md](WORKSPACE.md)) |
| `--trusted-ref` | its main as fetched | full 40-hex commit of `--repo` the trusted tree is checked out at: the skills the sanitize step restores and the repo's own `.github/greenlight/review.md`. CI passes one commit to every arm, so both stage from the same policy |
| `--model` | the policy's profile, mapped unless on Bedrock | model id for the local CLI |
| `--context-window` | `1000000` | window that model must report; pair it with `--model` or Bedrock |
| `--dry-run` | off | resolve the frame and sample, check the invocation, print the bill |

`--sample-n` is an upper bound rather than a promise. A sampled row can still be
dropped when its first-landing verdict turns out to be a canned decline, which
is only known after re-derivation, so the realised sample can come in a row or
two short. The run logs both numbers; everything downstream — the cost estimate,
the summary, the degraded ratio — counts what was actually attempted.

Exit codes: `0` a complete sweep; `1` nothing usable was produced — the frame was
empty, a startup check failed, the sweep was interrupted, or it stopped on a
fault every remaining run would have repeated; `3` the CSV was written but more
than half the attempted runs reached no verdict, so the new columns describe the
harness rather than the policy.

## Five ways to misread this file

**1. `decision != new_decision` is evidence to read, not a measurement.** Two
separate things make the difference between those columns unattributable to the
policy change.

The stored `decision` did not come from one policy. It came from whichever of
nine policy versions was live when that pull request was reviewed, and those
versions do not agree with each other: weekly `NO_LAND` rates over the corpus
run from 0.286 to 0.800 — a **51.4 percentage-point** spread, chi-square(7) =
60.5, p = 1.2e-10 as of 2026-09-18. The largest single week-over-week move
within that, **-33 points**, lands on a known policy change, which is the more
damning fact of the two: the baseline column does not merely vary, it steps when
the policy steps.

The reviewer also does not repeat itself. Asked twice about the *same* head SHA
it returned a different status 13 times out of 71 repeated pairs — 18.3%, 95%
confidence interval 11.0% to 28.8%. So on a 30-row sample, five or six flips are
the expected noise floor before the policy has done anything at all.

Quantifying a policy effect needs a control arm — the same sampled pull requests
re-reviewed under the *current* policy in the same sweep, on the same backend, at
the same time. **This tool does not build one.** What it produces is a list of
pull requests to go and read, and the reading is where the signal is.

**2. `verdict_staleness` means something different on multi-landing rows.** The
column compares the judged head against the pull request's *final* head. For a
pull request whose code reached main more than once, the version being replayed
is the *first* landing, which is not the final head. So on those rows
`verdict_staleness` reports how far the pull request drifted after the landing
being evaluated — usually reading `content-changed` — rather than telling you the
verdict was stale. That is why those rows are admitted to the frame regardless of
what the column says. Single-landing rows are admitted only at `exact` or
`rebase-only`, where the column means what it looks like it means.

**3. A rate computed over this file is a rate over the frame, not over
greenlight.** The frame drops pull requests that never landed, ones with no
verdict, canned declines, and stale single-landing verdicts. That is a large
share of the export and it is not a fixed one — it moves with the corpus.
Whatever you compute, say which population it is over, and put the run's own
funnel line beside it; in CI, that line is in the collect job's log.

**4. An empty `new_decision` is the harness, not a refusal.** The reviewer timing
out, tripping its budget, returning malformed JSON, or coming back empty all land
the same way: `new_decision` blank and `new_decision_reason` prefixed with
`harness:`. None of them is the policy declining to approve. Filter on that
prefix before counting anything, and check the exit status: a `3` means more than
half the runs are that shape and the file is describing an outage.

**5. This is not a re-run of CI.** See the deviations below. The serving path,
the context window and the comment set can all differ, and none is a controlled
variable here — a difference between `decision` and `new_decision` can come from
any of them as easily as from the policy. That is misreading 1's confound from a
second direction, and another reason a measurement needs a control arm run on
*this* harness. CI's `greenlight-policy-replay.yml` runs that control arm beside
the pull request's own, three times each on Bedrock; `compare.py` compares them.

## What gets replayed

The input is every pull request the export kept. The frame keeps the
ones whose stored verdict can be held against something that actually happened,
and the run logs the funnel it applied, one counter per stage. Each row is
charged to the first stage that rejects it, so the counts partition the input.
`multi_landing` is not a drop — it counts kept rows whose decision columns were
re-derived. **The stage list is `frame.FUNNEL_STAGES`**; read that rather than a
list in prose here, which goes stale. Three of those deserve saying out loud:

**Size-gate declines are excluded.** When the diff was over the workflow's line or
byte cap, CI dropped a canned `NO_LAND` in place and never started a model.
Re-running one of those measures the cap, not the policy, so they are dropped
from the frame by matching the canned message, as are the staging gates' canned
declines ([WORKSPACE.md](WORKSPACE.md)). A *new* cap can still decline a
pull request that was reviewed before; that row keeps the canned verdict, is
counted as a verdict, and costs nothing — no checkout is taken for it.

**Pull requests that never landed are excluded**, along with those greenlight
never reached a verdict on. There is nothing to hold a new verdict against.

**Pull requests whose code reached main more than once are admitted regardless of
`verdict_staleness`**, and the first landing is what gets replayed. See
misreading 2 before reading that column on those rows. Their decision columns are
re-derived as of that landing, which costs a ClickHouse query and two compare
calls apiece — paid for the sampled rows only, not the whole frame.

## Stack context

A policy whose workflow runs the "Collect stack context" step shows the reviewer
the open pull requests among the five directly above the reviewed one in its
ghstack or GitHub stack, each with its diff. The replay rebuilds that as of the
replayed verdict's `decision_version`, the cutoff the comment filter uses, rather
than as of today: by replay time the pull requests above a landed one have
usually closed, and ghstack has rewritten the listing in the body. A GitHub
stack's is rebuilt best effort, from its membership today, by `stack_native.py`.

**The step is pinned.** `stack_step.py` and `stack.py` reproduce its ghstack
branch line by line, bar its check of a sibling's base name, which the rebuild,
diffing from the base's SHA, never reads. Loading a policy refuses a step
digesting to none of `stack_step.STEP_SHA256`, `PYTORCH_ONLY_STEP_SHA256` (the
version that named pytorch/pytorch rather than the reviewed repo) and
`GHSTACK_ONLY_STEP_SHA256`, the ghstack-only version, which replays as CI ran it. Every key but `name`
counts: an edited `run:`, `env` or `shell`, or an added `if:`, is refused. The
gate finds it by a `run:` naming `/tmp/greenlight-stack` and refuses a second
one; neither its order nor its job is checked. A policy without the step replays
with no stack context, as CI ran it, and so does one with the step moved into a
script, a known limit. Changing the step means porting it and re-pinning.

**The body is read back under every policy.** For every ghstack pull request
whose diff the size gate lets through, the metadata document's body is the body at
the cutoff: the newest revision edited at or before it. That holds whether or not
the policy has the step, so a control arm and the stack arm show one body. Other
pull requests keep today's body, a deviation apart from the stack context.

Per ghstack pull request that costs one GraphQL query for its edit history, plus
one per further 100 revisions; per other pull request, when the step covers GitHub
stacks, one for its stack. In a stack the step covers, it also costs:

- one aliased GraphQL query for the up to five pull requests above it: when each
  opened and closed, its last 100 commits, and a count of force-pushes of its
  head, and in a ghstack of its base and of retargets, after the cutoff;
- one REST compare per pull request kept, from its final `baseRefOid`, or in a
  GitHub stack the head then of the entry below, to its newest commit dated at or
  before the cutoff, capped at 2000 lines like the step.

Telling a pull request is not ghstack costs nothing more: the `gh pr view` the
metadata already makes reports its head branch. If that call fails under a policy
with the step, one GraphQL query finds out instead. One whose diff the size gate
declines costs nothing: its canned verdict reads no context.

**Where CI degrades, the replay fails the row.** The step is `continue-on-error`,
and any fault in it quietly drops the whole context. Here only the step's own
exits write nothing and carry on: a pull request in no stack the step covers, or
not named in its own listing. Anything else removes whatever was written and
fails the row into the error count, where a rerun retries it: a GitHub error, a
head or base rewritten after the cutoff, more than 100 commits, or a body or head
that cannot be pinned to one revision then. A GitHub stack skips such an entry,
and the one above.

## The new columns

Four, appended to the export's own 34. They are the only columns the replay
writes; every other cell is the input row, untouched.

- `new_decision` — `LAND`, `NO_LAND`, or empty. Never anything else: a status
  outside that vocabulary is dropped rather than written, so no harness artefact
  can reach the column every comparison keys on.
- `new_decision_reason` — the reviewer's machine-readable reason code, or
  `harness:<outcome>` when the run produced no usable verdict. No real reason code
  contains a colon, so the prefix cannot collide with one. See misreading 4.
- `new_decision_summary` — the first sentence of the message, capped. For
  scanning; quote the full message, not this.
- `new_decision_message` — the reviewer's full prose.

A sampled pull request that never reached the reviewer at all — the checkout
failed, the diff could not be fetched — has no row in the output. The count is
logged and folded into the exit-status ratio; the file has no placeholder for it.

## Cost, time and stopping early

Measured over 872 real CI reviewer runs: **$1.33 and 9 to 11 minutes per run**,
with the slowest at 36 minutes. A run that comes back with no verdict or an
invalid one is retried once, and both attempts are billed.

The 37-minute default timeout is not derived from that spread. It is the CI model
step's own bound, and it sits above the 33-minute hard review budget so the
reviewer runs out of budget before it runs out of process.

The first pull request of a sweep runs alone before the rest fan out. That warms
the prompt cache — concurrent cold starts each pay the whole prompt in — and it
is also the circuit breaker. Three outcomes cannot vary by pull request: the
model the gateway resolved, the schema the policy ships, and the prompt the CLI
parsed. If the warm-up hits one, every remaining run would hit it too, so the
sweep stops there rather than billing them. Its one diagnostic row is still
written, and the exit status is `1`.

Every finished run is appended to `<workdir>/<policy>/checkpoint.jsonl` and
fsynced, and the CSV is built from that file rather than from memory. Two
consequences:

- Ctrl-C stops new runs, lets the in-flight ones finish, and still writes the CSV
  for everything judged so far. A second Ctrl-C kills the process outright, and
  `--resume` then picks up from the checkpoint. An interrupted sweep exits `1`
  even though it wrote a file, because it is not a complete answer.
- `--resume` skips only the pull requests that reached a verdict. One the harness
  spoiled — a timeout, a budget trip, an outage — is re-run, because recovering
  those is the usual reason to resume at all. It also drops any entry recorded
  against a different head than the row now names, so re-exporting the corpus
  mid-sweep cannot pair a verdict with code it never judged.
- Without `--resume`, an existing checkpoint for the same policy is moved aside
  rather than reused or deleted. Its verdicts stay on disk beside the new ones,
  under a timestamped name.

## Workspaces, scratch layout and staging

What lands under `--workdir`, what each reviewer slot holds and why, and how a
policy tree with `repo-policy.py` stages the reviewed repo's policy and gates
before the model are in [WORKSPACE.md](WORKSPACE.md).

## The model

**The model is mapped, not defaulted.** The policy names a Bedrock inference
profile, which the local gateway does not resolve, and the runner asserts that the
model which answered is the one it asked for, so passing it through fails every
run. Quietly substituting a default is worse: a policy pull request that switches
models would replay on the model it replaced and read as a clean sweep of the new
policy. So `sweep_setup.LOCAL_MODELS` translates the profile, an unrecognised one, such
as today's, stops the sweep before the clone, and `--model` overrides it. With
`CLAUDE_CODE_USE_BEDROCK=1` the profile passes through as the CLI's model id.
**Pair `--model`, or Bedrock, with `--context-window`**: a run reporting any other
window is rejected, so every review fails. The warm-up catches that after one run,
not thirty, but setting both is cheaper than finding out. CI keeps its window
beside its CLI pin in `greenlight-policy-replay.yml`; the two change together.

## How this differs from CI

Six deviations, taken deliberately:

- **Different serving.** CI runs the model through Bedrock at a 200k context
  window. This runs it through a local gateway at 1M. Same model, different
  serving path and different window. A Bedrock run on CI's CLI removes both.
- **Different CLI build.** The local `claude` is whatever is installed, not the
  build `anthropics/claude-code-action` pins, which the CI replay installs.
- **Different comment set.** The reviewer sees only comments created strictly
  before the replayed verdict, which is the point — it must not read what was
  written in response to the verdict it is reproducing. A comment whose
  `createdAt` cannot be parsed is dropped here, where CI would have shown it.
- **Stack context read back, not captured.** Everything the stack step read is
  read again as of `decision_version`, with these gaps:
  - `decision_version` lands a median of about 8 minutes after the step ran, and
    the stack can move in between: of 50 ghstack rows measured, 3 get a different
    stack at `decision_version` than at review start. In 2, the listing itself
    changed by the cutoff: #197608's gained #197618 and #197651's lost #197660.
    The exact instant, the `AI_REVIEW_STARTED` row in `misc.greenlight_pr_state`,
    would cost one more ClickHouse lookup and is not used.
  - A pull request's head at the cutoff is picked by commit date, which matched
    the actual push time in 937 of 948 cases. Over all 4,733 pushes the median
    push lag is 11 s; the 11 misses were 5 late pushes and 6 from one account
    whose clock ran 7 h fast. One re-pushed within seconds of the step is
    ambiguous: 1 of 244 ghstack pull requests with context in the 2026-09 corpus.
  - Whether it was open then is read from `closedAt`, which a later reopen
    rewrites, so one closed at the cutoff and reopened since reads as open: 1 in
    3,517 checks (pytorch/pytorch#197050).
  - Titles are read as they are today, and so is a GitHub stack's membership.
- **A channel CI does not have.** The reviewer runs with the developer's real
  `$HOME`, so user-level hooks still fire — including, on some setups, a
  `SessionStart` that injects a skills catalog. `--append-system-prompt`
  neutralises it. The greenlight skill's Security section trains the model to
  classify unexpected out-of-band instructions as `injection_attempt`, so such a
  run carries both the injection and a directive about it. A scratch `HOME` would
  remove both; it is untested, because testing it costs a model run.
- **Different harness.** Three hook registrations the workflow makes are absent,
  for two reasons: `validate-on-stop.sh` hardcodes a path the per-run remap moves,
  so the verdict is validated and retried by this tool instead; and the
  instruction-loading detector's `SessionStart` and `InstructionsLoaded` hooks
  exist to leave a manifest for a later CI step that does not run here.

Everything else comes from the policy tree at the ref under test: the prompt, the
diff caps, the canned too-large verdict, the schema, the remaining hooks, the
staging script and its canned verdicts, and the sanitize step that strips the
reviewed checkout's own agent instructions before the model sees it.

**It invokes `claude` directly rather than through any local wrapper**, because a
wrapper that forces its own flags makes `--restricted` unusable and loads MCP
tools — including GitHub writes — that a reviewer confined to reading one
checkout must not have.
