# Replay parity with the live review

A replay is evidence about a policy only where it does what the live review job
does. This file lists every input of a live review and how the replay gets it, and
says how the shape registry in `ledger.py` keeps that list true when the review
workflow changes. Usage is in the [README](README.md).

## Inventory

### Derived from the arm's tree

Read out of the policy under test, never defaulted by the harness:

- the prompt (`workflow.prompt`, rendered by `prompt.py`);
- the model, effort and tool allowlist (`workflow.claude_args`). `--allowedTools`
  becomes the hard `--tools` allowlist, and any other flag, or a tool beyond Read,
  Glob, Grep and Write, is refused;
- the line, byte and file caps (`workflow.diff_caps`);
- the three review budgets (`workflow.review_budgets`);
- the per-run timeout: the action step's `timeout-minutes`, which
  `--timeout-minutes` overrides. One above 40 minutes is refused, since a longer
  review could outlive the credentials the CI replay started it with;
- the canned verdicts: `too-large-verdict.json` from the policy's hooks, and the
  no-policy `NO_LAND` the keep-policy step writes with its own `jq -n` program;
- the hook settings (`settings.derive_hook_settings`): the matchers, commands,
  `claudeMdExcludes`, SessionStart and InstructionsLoaded hooks of the heredoc
  writing `.claude/settings.local.json`, with the checkout substituted as the
  step's `sed` does;
- `outputStyle`, from the action step's `with.settings`.

### Run as the arm's own code

`arm_code.py` runs each in a subprocess whose environment is built from nothing:

- target resolution and admission: the arm's `greenlight target` names the repo,
  its checkout directory, its policy file and whether that file exists, once per
  sweep;
- the sanitize script, on every checkout;
- the hooks, from the materialized tree by absolute path;
- the instruction-loading detector, after every session that started;
- record-side acceptance. A verdict counts only when the record job's own
  validation step and the arm's `greenlight verdict --dry-run` both accept it; the
  second carries the full validation sequence, the secret scrub included, and its
  scrubbed message is what the replay records. The canned verdicts pass the same
  two checks.

### Reproduced in harness code and registered

- the policy checkout (`policy.py`), the reviewed checkout (`checkout.py`) and the
  trusted-skills checkout (`trusted_skills.py`);
- the diff, metadata and stack fetches (`inputs.py`, `stack.py`,
  `stack_native.py`), cut off at the replayed verdict;
- the size gate's counting (`size_gate.py`);
- the budget epochs (`reviewer_env.py`);
- whether the model runs (`sweep.py`, `runner.py`);
- the remaining shape of the review and record jobs, registered by digest in
  `ledger.py`.

### Declared, not reproduced

- **The session.** The replay runs `claude -p --restricted --tools ...` with an
  appended system prompt and one `--add-dir` per root. The live job runs the
  action's SDK entrypoint with the user, project and local setting sources, the
  full tool list behind permissions, project skills and `CLAUDE.md`, and the
  action's own environment and settings. Two hooks need a private `/tmp` per
  session, which the replay does not have, and are left out with it: the Stop hook,
  whose `validate-on-stop.sh` watches `/tmp/greenlight-verdict.json` where the
  per-run remap moves the verdict, so the record checks above decide instead; and
  the budget hook's probe for that verdict. A follow-up change runs the action's
  own entrypoint in a private `/tmp` per session and closes this.
- **The serving path.** CI runs the model through Bedrock at a 200k context
  window; a local replay runs it through a local gateway at 1M. Same model,
  different serving path and window; a Bedrock run on CI's CLI removes both. The
  job's runner, environment and credentials are not reproduced either.
- **The CLI build.** A local `claude` is whatever is installed, not the build
  `anthropics/claude-code-action` pins, which the CI replay installs.
- **The hook interpreter.** A review job setting up Python 3.13 runs its hooks
  under it; one setting up none, and the replay, run them under the system
  `python3`.
- **PyYAML** is pinned in `greenlight-policy-replay.yml` to the version
  `greenlight/uv.lock` locks, which `test_ledger.py` checks, rather than taken from
  each arm's lockfile.
- **The trusted skills** come from the reviewed repo's main as it is when the
  replay runs, not when the review ran.
- **The git credentials** the action writes into the checkout.
- **The comment set.** The reviewer sees only comments created strictly before the
  replayed verdict, which is the point: it must not read what was written in
  response to the verdict it is reproducing. A comment whose `createdAt` cannot be
  parsed is dropped, where CI would have shown it.
- **Stack context is read back, not captured.** Everything the stack step read is
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
  `$HOME`, so user-level hooks still fire, including, on some setups, a
  `SessionStart` that injects a skills catalog. `--append-system-prompt`
  neutralises it. The greenlight skill's Security section trains the model to
  classify unexpected out-of-band instructions as `injection_attempt`, so such a
  run carries both the injection and a directive about it. A scratch `HOME` would
  remove both; it is untested, because testing it costs a model run.

## The shape registry

`ledger_shape.py` reduces an arm's `greenlight-pr-review.yml` to its shape, an
ordered list of entries, each digested with `stack_step.step_digest`:

- the workflow's `env`, `defaults`, `permissions` and `concurrency`;
- the review job's keys other than `steps`;
- each review step, and after a step whose `uses:` is `./<path>`, that local
  action's `action.yml`;
- the whole record job.

What the replay derives or runs is masked: its value is replaced and its key kept,
so retuning it needs no registration while adding or removing it does. Masked are
the review budgets; the action step's `prompt`, `settings` and `timeout-minutes`
and the values of its `claude_args` flags; the size gate's caps; the hook settings
heredoc's body; and the record job's validation `run:`. The stack step is masked
out whole, its position kept: `stack_step.STACK_CONTEXT_BY_PIN` is its one check.
A step's `name` is never digested.

`ledger.py` maps each registered shape's digest to a `Variant`, and `CLASSES`
gives every entry's class: derived, run as the arm's own code, reproduced by a
named module, or not reproduced, with the reason. `policy.materialize` refuses an
arm whose shape is not registered before it runs any of the arm's code, naming
each entry whose digest no registered shape has. `test_ledger.py` fails the
torchci workflow when this tree's shape is not registered, and checks that the
replay and the tests start whenever anything the shape reads or the arm's code
runs changes.

### Registering a shape

Register a shape only after confirming that the harness reproduces it.

1. Port the change: make the harness derive, run or reproduce the new or changed
   step, with tests.
2. Confirm it: the derivation test in `test_ledger.py` materializes the tree for
   every configured repo and policy file, and a replay run shows the change
   reproduced.
3. Add a `Variant` to `ledger.VARIANTS` with the shape's digests in order, and give
   each new digest its class in `ledger.CLASSES`. Its notes say why the harness
   reproduces each part that differs from a registered variant. To list every
   entry of the tree's shape:

   ```bash
   cd tools/torchci
   python3 -c 'from pathlib import Path
   from torchci.greenlight_replay import ledger_shape, workflow
   root = Path("../..").resolve()
   path = root / workflow.WORKFLOW_RELPATH
   for entry in ledger_shape.shape(workflow.load(path), root, path):
       print(entry.digest, entry.label)'
   ```

### Retiring a variant

The base arm of a replay is the merge base of the pull request under test, so a
variant is added, never edited or replaced, while an open pull request's merge
base can carry its shape. A variant is retired, with the classes only it uses,
once no open pull request's merge base does; an arm of that shape is then refused,
and its pull request needs rebasing onto main to be compared.
