---
name: vllm-pytorch-ci-triage
description: Triage a failing vLLM Buildkite CI build for a PyTorch version-bump PR, isolate new regressions vs. pre-existing failures on main by comparing against recent "Full CI run - nightly/daily" builds, classify by root cause, and file one grouped issue per root cause in pytorch/pytorch (linked under an umbrella issue). Use when the user points at a Buildkite build for a torch/triton upgrade and asks "what's broken that isn't broken on main" or "file issues for each failure".
---

# vLLM × PyTorch version-bump CI triage

End-to-end workflow for triaging a vLLM CI run that tests a new torch/triton release and filing upstream issues for the real regressions. Derived from the multi-week triage of vLLM PR #40077 (torch 2.12.0 + triton 3.7.0) starting 2026-04-20 against Buildkite build #62138 → filed 16+ issues under umbrella `pytorch/pytorch#180899` over a series of daily runs (62138 → 62232 → 62495 → 62583 → 62848 → 63095). The workflow handles both first-time triage and ongoing daily monitoring.

---

## Prerequisites

Both tokens must exist on disk with `600` perms. Do NOT paste into chat.

```bash
# Buildkite API token — https://buildkite.com/user/api-access-tokens
# Scopes: read_builds, read_build_logs. Must be a member of the `vllm` org.
umask 077 && printf '%s\n' 'bkua_...' > ~/.buildkite_token && chmod 600 ~/.buildkite_token

# GitHub PAT — https://github.com/settings/tokens/new
# Classic token with `public_repo` scope is enough (pytorch/pytorch + vllm-project/vllm are public).
printf '%s\n' 'ghp_...' > ~/.github_vllm_token && chmod 600 ~/.github_vllm_token
```

Shell state does NOT persist between Bash tool calls — always read tokens per-invocation via `$(cat ~/.foo_token)`.

`gh` CLI may not be installed (it wasn't in this env). Use raw `curl` against the REST API.

---

## Inputs the user usually provides

- A failing Buildkite build URL, e.g. `https://buildkite.com/vllm/ci/builds/62138`
- Optionally the PR (e.g. `vllm-project/vllm#40077`)
- An umbrella issue (e.g. `pytorch/pytorch#180899`) — if present, append new issues to its checklist

If only the Buildkite URL is given, the build JSON contains the commit, branch, and PR link.

---

## Workflow

### Step 1 — Confirm build state, get totals

```bash
TOKEN=$(cat ~/.buildkite_token)
curl -sH "Authorization: Bearer $TOKEN" \
  "https://api.buildkite.com/v2/organizations/vllm/pipelines/ci/builds/<N>" > /tmp/bk_<N>.json
```

**Pitfall:** the anonymous JSON endpoint (`https://buildkite.com/vllm/ci/builds/<N>.json`) returns statistics only — `jobs: []` is empty without auth. Always use `api.buildkite.com`.

Inspect `jobs[*].{name,state,soft_failed,exit_status,id,web_url,log_url}`.

### Step 2 — Filter to BLOCKING failures only

A vLLM "failed" job can be non-blocking (`soft_failed=True`). User told us to ignore those. Also exclude `waiting_failed` (downstream cascades).

```python
def hard_fails(path):
    d = json.load(open(path))
    return [(j['name'], j.get('exit_status'))
            for j in d['jobs']
            if j.get('state') == 'failed' and j.get('soft_failed') is False]
```

### Step 3 — Compare against recent full builds on main

The full builds are commits on `main` whose message starts with `Full CI run - nightly` or `Full CI run - daily`. Pull the last ~week:

```bash
curl -sH "Authorization: Bearer $TOKEN" \
  "https://api.buildkite.com/v2/organizations/vllm/pipelines/ci/builds?branch=main&created_from=YYYY-MM-DDT00:00:00Z&per_page=100" \
  > /tmp/main_builds.json
```

Grep for `"Full CI run - nightly"` and `"Full CI run - daily"` in the message, then fetch each build's JSON with the same endpoint as step 1.

**Compare SIGNATURES, not just job names.** A job-name overlap with main is *not* sufficient to drop a failure — main may fail the same job for an entirely different reason. Examples seen in this engagement:

- `V1 Core + KV + Metrics` failed on both PR (62495) and main (62254). PR signature: `Expected: 0.54 \| Measured: 0.4806` (real accuracy regression). Main signature: `Server exited unexpectedly` (infra flake). Two different bugs sharing a job name.
- `Entrypoints Integration (API Server openai - Part 3)` similarly: PR fails on `test_multi_chunk_streaming[Voxtral]`, main fails on `test_openapi_stateless` schemathesis.

Workflow: if a job-name overlaps with main, fetch the main log and compare the FAILED test ID + exception. Only drop if signatures match.

Verify against ≥3 recent main builds before declaring a failure "new" — a single-build pass-or-fail isn't decisive (some jobs flake; some main builds get interrupted). Five-build crosscheck (5 × Full CI runs covering ~3 days) gives a confident verdict.

**CRITICAL: an infra-killed main job is not a baseline.** A main-build job that exits with `exit_status=125` (`nvidia-container-cli` driver/container error), `started_at=None` + 0-byte log, or any other infra-kill signature **never actually ran the test** — treating it as "missing" or "passing" will produce false positives. If most/all recent main builds had a job killed by infra (especially the cluster of B200 nvidia-container-cli timeouts that hit many B200 jobs at once), the comparison is invalid:

- **Do not file a "new on test PR" issue** based on this — the test could fail on torch 2.11 too, you just have no evidence either way.
- **Ask the user (or the release manager) to retry the main nightly** for the specific job. A retried successful run on main is the only valid baseline.
- Once retried main completes, compare signatures. Sometimes the failure on main matches the test PR exactly (i.e. it's a pre-existing vLLM bug, not a torch regression — retract).

Real example (2026-05-05): `MoE Refactor Integration Test (B200 - TEMPORARY)` was hit by `exit 125` on every recent main build. Test PR 64468 ran it successfully and caught a GSM8K accuracy floor failure (0.2085 < 0.2100). I filed it as a torch 2.12 regression — wrongly. Once main 64432 was retried and actually ran the test, it produced the same signature with **0.2039** (worse than the test PR). Retracted as not_planned. The skill should reflect: when the main baseline is missing because of infra, *demand a rerun before filing*.

### Step 4 — Pull logs for the survivors

Log endpoint (plain-text variant):

```bash
TOKEN=$(cat ~/.buildkite_token)
# IMPORTANT: read token INTO a variable first; inline `$(cat ...)` inside a
# backgrounded curl inside a `while read` loop silently fails (returns 0-byte
# files). Lesson from first attempt that produced all-empty logs.
for id in <JOB_IDS>; do
  curl -sL -H "Authorization: Bearer $TOKEN" \
    "https://api.buildkite.com/v2/organizations/vllm/pipelines/ci/builds/<N>/jobs/$id/log.txt" \
    -o "/tmp/logs_<N>/$id.log" &
done
wait
```

### Step 5 — Strip ANSI + timestamp markers, extract root-cause lines

Buildkite logs contain `\x1b_bk;t=...\x07` timestamp markers and ANSI color codes. Strip them first:

```python
import re
ANSI = re.compile(r'\x1b\[[0-9;?]*[a-zA-Z]')
BKT  = re.compile(r'\x1b_bk;[^\x07]*\x07')
def clean(s): return BKT.sub('', ANSI.sub('', s))
```

Useful signal patterns to scan cleaned logs for:

- pytest summary line: `= \d+ failed`
- Explicit `RuntimeError: ...` / `AssertionError: ...` / `ValueError: ...` (skip the generic `raise RuntimeError(` *frames* — they hide the real message)
- `FAILED tests/.../...::test_name` lines (pytest verbose output)
- Infra: `ECR`, `docker pull`, `Connection refused`, `no space left on device`, `exit status 137`
- GPU contention: `Free memory on device cuda:0 (X/Y GiB) on startup is less than desired`

**Critical:** the literal "Engine core initialization failed. See root cause above." is never the root cause — scan upward for the *actual* exception line logged by the EngineCore worker process.

### Step 6 — Group by root cause

The goal is ONE issue per root cause, not per failing job. From the 2026-04-20 triage, 22 failing non-CPU jobs grouped into 10 distinct root causes. Several causes produced >4 failing jobs each (e.g. Inductor MetaProxy → 4 Fusion E2E variants).

Separate out:
- Infra/resource contention → **auto-restart** the affected jobs (see Step 6.5), don't file.
- Test-case assertions that look like real regressions (e.g. `accuracy 0.48 < 0.54` threshold).
- Torch/triton framework regressions → **pytorch/pytorch**.
- vLLM-side application bugs (response APIs, multimodal) → **vllm-project/vllm**.

### Step 6.5 — Auto-restart transient-infra failures (do this automatically; do NOT file)

Transient-infra jobs get **automatically retried** on the same build — this is a job-rerun,
the one Buildkite write action the triage is allowed to take on its own (it never posts
issues/comments automatically). Retry a blocking-failed job **iff** its log matches a
*transient* infra signature AND does not match a hard-skip signature:

**Retry (transient — a rerun can recover it):**
- `CUDA driver initialization failed` (`torch._C._cuda_init()`; incl. the "Engine core init
  failed" wrapper and the NVML `CUDACachingAllocator.cpp` variant)
- `nvidia-container-cli: initialization error` / driver rpc timeout
- `exit_status == 125` (container/agent init)
- docker setup-hook failure (`docker command hook exited with status 1` before any test ran)
- ECR `toomanyrequests` / `Data limit exceeded` (registry rate-limit)

**Never retry (a rerun cannot fix it — leave for a human / different action):**
- `manifest unknown` / `not found: manifest` — a required image was never built/pushed; needs
  an image rebuild, not a retry. **Report it, don't retry.**
- `undefined symbol` / real test assertions / accuracy floors — real signal.
- `ModuleNotFoundError: No module named 'torch'` build-isolation — benign/known.
- Anything whose signature you can't positively classify → do NOT retry (retry only on a
  *confirmed* transient-infra match, so unknowns are surfaced, not silently rerun).

Retry via the REST API (needs `write_builds` scope on the token):
```bash
curl -s -X PUT -H "Authorization: Bearer $(cat ~/.buildkite_token)" \
  "https://api.buildkite.com/v2/organizations/vllm/pipelines/ci/builds/<N>/jobs/<JOB_ID>/retry"
```
Rate-limit discipline (REST API is **400/min**): fetch logs serially and space the retry PUTs
(~0.5–1s apart, with exponential backoff on HTTP 429). A burst will get `429` and silently
no-op. See the standalone example at the end of this section.

**Within-build retry is infra-recovery, not a reproducibility test** (Step 12.4): retrying an
infra job to get it onto a healthy agent is correct; but a retry that fails again does NOT
prove a real regression (same image/agents). Only a *fresh build* proves reproducibility.

**Log what you restarted.** Emit a per-run list of `{job, signature, retry_status}` and the
skipped set with reasons — silent restarts hide a persistently-broken fleet. If the SAME
transient-infra signature dominates two consecutive runs, escalate: recommend a full rebuild
on a healthy fleet rather than another round of same-build retries.

### Step 7 — Draft and confirm before posting

Public issues are high-blast-radius. ALWAYS:

1. Draft the full title + body in chat.
2. Ask the user for explicit "post" / "edit: ..." / "skip".
3. Post one at a time, or in a single batch only after the user approves the whole set.

Title convention: **always start with `[vllm]`**, then a sub-area tag, then a concise root-cause. Examples:
- `[vllm] [2.12 regression] torch.library.Library.impl("aten::bmm", ...) now fails ...`
- `[vllm] [triton 3.7] PassManager::run failed in make_ttgir ...`
- `[vllm] [2.12 regression][Inductor] prims.convert_element_type receives MetaProxy ...`
- `[vllm] [2.12 regression][CPU] torch.compile fullgraph=True raises "found no compiled frames" under Intel SDE`
- `[vllm] [2.12 regression][B200] test_batch_invariance: nondeterministic outputs 3/5 trials`

**Package name is `triton`, not `pytorch-triton`** (common mistake — the PyPI name is `triton`).

Body sections to include:
- **Summary** with the single-line exception message quoted.
- **Environment** block: exact torch / triton / CUDA / Python / GPU.
- **Reproduction** or the specific failing test IDs.
- **Traceback** (trimmed — 10–20 relevant frames).
- **Question / diagnosis** — invite the maintainer to clarify intentional behavior change vs. regression.
- **Links** — vLLM PR, Buildkite build, the specific failed job (click-through URL uses the job id as fragment: `…/builds/<N>#<job-uuid>`), umbrella issue.

### Step 8 — Post via GitHub REST API

```bash
curl -s -X POST \
  -H "Authorization: Bearer $(cat ~/.github_vllm_token)" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/pytorch/pytorch/issues \
  -d @/tmp/issue_body.json
```

**JSON body shape:** `{"title": "...", "body": "...markdown..."}`. Labels and assignees intentionally omitted — let maintainers triage.

### Step 9 — Link to umbrella

Fetch the umbrella body, find the last numbered checklist line (`^\d+\. \[[ x]\] https://github.com/pytorch/pytorch/issues/\d+`), insert the new link(s) with incremented numbers, PATCH:

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer $(cat ~/.github_vllm_token)" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/pytorch/pytorch/issues/<UMBRELLA> \
  -d "{\"body\": <escaped new body>}"
```

Always re-fetch the umbrella body before patching — other people may have edited it in between.

### Step 10 — Post-filing corrections

Titles and bodies can be bulk-PATCHed; simple string replacements work fine:
```python
new_title = old_title.replace('pytorch-triton', 'triton')
new_body  = old_body.replace('pytorch-triton', 'triton')
```

### Step 11 — Recurring runs (daily monitoring)

Once the umbrella exists, subsequent test-PR builds are *not* "open new issues per failing job" — they're **delta analysis**. For each new build:

1. Re-fetch the umbrella body and the JSON of every linked issue. Cache issue states (open/closed) keyed by number.
2. **Auto-restart transient-infra failures first (Step 6.5).** Before classifying real signal,
   retry every blocking-failed job that positively matches a transient-infra signature
   (CUDA-driver-init storm, nvidia-container-cli, exit 125, docker setup-hook, ECR rate-limit),
   skipping missing-image (`manifest unknown`), real regressions, and benign modes. This both
   recovers the run and prevents infra noise from polluting the delta. Record the restarted vs
   skipped lists in the run report/state.
3. Match each hard-failed job in the new build against tracked-issue signatures (build a regex map from issue titles/bodies). Three buckets:
   - **Still reproducing**: tracked issue still hits → no new issue. If the user wants, PATCH the existing issue body to append the new build link to a Reproducibility section.
   - **Newly silent**: previously-failing job/test now passes. Don't immediately close — wait for ≥2 consecutive runs of "silent" before suggesting close.
   - **Unmatched**: failing job whose signature isn't in any tracked issue. Cross-check against ≥3 main builds (per Step 3). If new on the torch-bump branch, draft + post a fresh issue and append to umbrella.
4. Maintain umbrella checklist hygiene: mark `[x]` on items that are closed upstream OR confirmed silent for ≥2 runs. Numbering continues — never reuse numbers.

**Updating an existing issue's reproducibility list** (PATCH pattern):
```python
old = "## Links\n\n- vLLM PR: ...\n- Failing build: <single old build>\n..."
new = """## Reproducibility on torch 2.12 branch

Same `<exact signature>` on the same N tests across every test-PR run since YYYY-MM-DD:

- 2026-04-20: <buildkite URL with #job-uuid>
- 2026-04-22: <buildkite URL with #job-uuid>
- ...

Passes on same-day main builds (torch 2.11): <list of main build numbers>.

## Links

- vLLM PR: ..."""
new_body = body.replace(old, new)
```

### Step 12 — "Closed upstream but still reproducing" check

When a tracked issue's state flips to `closed` but the same signature keeps appearing in subsequent builds, the fix is in pytorch `main` but not yet in the test-channel wheel that vLLM CI pulls. Verify by comparing timestamps:

```bash
# Closing commit timestamp from the issue's timeline
gh_close = events[event=='closed'].created_at  # commit that auto-closed
# Build start time on the test branch
build.created_at
# Test-channel wheel build timestamp (look at torch dist URL or PEP-503 index page)
```

If `build.created_at > closing_commit.created_at` but the failure persists, the wheel predates the fix. Recommendation: cherry-pick the fix to the release branch and rebuild the RC wheel. Don't reopen the issue — it really is fixed in main.

### Step 12.4 — A within-build retry is NOT a reproducibility test

**Critical lesson, do not skip.** When Buildkite shows a job failed and someone clicks "retry" on the same build, the retry runs on the **same Docker image, same wheels, same agent state, often the same agent machine**. It does not rebuild the image, does not re-pull torch wheels, does not refetch HF caches — it just re-executes the test script.

This means:

- **Two failures on the same build are NOT independent samples.** If a flake is rooted in image-build artifacts, agent contamination, or a one-time HF download corruption, every retry will hit the same bug. Calling that "reproducible" is wrong.
- **A retry pass within the same build does prove flake** (the test ran twice in identical conditions and got two outcomes). That direction is fine.
- **A retry fail within the same build proves NOTHING about reproducibility.** It only proves the failure is deterministic given the artifacts.

The only valid reproducibility test is a **fresh build**:

1. The same vLLM commit re-built into a new test image, OR
2. A different vLLM commit that contains the suspect change.

Real example (2026-05-06 → 2026-05-07): `test_cascade_attention[FLASH_ATTN]` failed on 64577 (run 1) and 64577 (retry). I called it "reproducible" and filed pytorch/pytorch#182700 + bisected to vllm-project/vllm#41181 via a revert build (64803). That conclusion was **wrong** — when the test PR rebased onto a newer main and put #41181 back in (64854), the test passed, and #41181 has been on main builds 64792 + 64859 the whole time without breaking them. The 64577 failure was something specific to 64577's image/wheels — likely a transient artifact issue that got smoothed over by a fresh image build.

How to apply:

- Before drafting any "new regression" upstream issue, require **at least one PASS on a fresh build** (different image SHA) as the failing baseline, AND the failure to recur on a second fresh build with the suspect change.
- Treat retry-within-build as **necessary but not sufficient** for "reproducible".
- If you've already filed an issue on a within-build-retry conclusion and a fresh build then passes, retract honestly and update the umbrella.

### Step 12.5 — Reopen vs file new

Before drafting a "new" issue for an unmatched failure, search the umbrella's *closed* entries by exact failure-text fragment:

```bash
# Compare the failing-test signature ("Generated text X doesn't match...", op name, etc.)
# against every closed umbrella issue's title + body. If you get an exact match,
# REOPEN the closed issue + post a comment with new build links — do not file a duplicate.
```

A regression that re-appears (closed issue's signature reproduces in a later run) often means either (a) the upstream fix was reverted or (b) a new vLLM-side change re-exposed the same code path. Reopening preserves history and avoids fragmenting the discussion.

PATCH pattern:
```bash
# Reopen
curl -X PATCH .../issues/<N> -d '{"state":"open"}'
# Post comment with new build data
curl -X POST .../issues/<N>/comments -d @comment.json
# Update umbrella: change `[x]` back to `[ ]` and add a "reopened YYYY-MM-DD" note
```

### Step 12.6 — Custom-op stride/shape mismatch is almost always a vLLM-side fake-kernel bug, NOT a torch regression

When you see this signature:
```
AssertionError: expected size N==N, stride A==B at dim=0
Error in op: torch.ops.vllm.<X>.default
This error most often comes from a incorrect fake (aka meta) kernel for a custom op.
```

**Default assumption:** vLLM's registered fake kernel for that custom op returns a different shape/stride than the runtime kernel. The check itself (`assert_size_stride`) is not new in any torch release — it's been there for years (see `pytorch/pytorch#177719` discussion to disable it for vLLM perf).

Why torch X passes and torch Y fails on the *same* vLLM commit can mislead you here:
- AOTAutograd cache hit may have bypassed recompile under torch X
- `torch.Tag.needs_fixed_stride_order` only inserts the assert when Inductor sees a stride change
- Torch Y might exercise a slightly different graph capture path

Look for the root cause in vLLM, not torch:

1. Find where the custom op is registered:
   ```bash
   git grep -rn "direct_register_custom_op" vllm/ | grep -E "op_name=.<your_op>."
   git grep -rn "register_fake|fake_impl|impl_abstract" vllm/ | grep <op>
   ```
2. Read the `fake_impl=` function — what shape does it return?
3. Read the actual implementation (`op_func=`) and any expert/dispatcher classes it calls — what shape do they actually allocate?
4. Bisect with `git log --stat <last-passing>..<first-failing> -- <suspect dir>` to find the vLLM commit that introduced the mismatch.

Real example from the gpt-oss MoE Blackwell triage:
- Op: `torch.ops.vllm.moe_forward.default`
- `_moe_forward_fake` returns `torch.empty_like(hidden_states)` → padded `hidden_dim` (3072)
- `TrtLlmMxfp4Experts{Monolithic,Modular}` was changed by vllm-project/vllm#40960 to allocate at `hidden_dim_unpadded` (2880)
- Inductor caught it with `assert_size_stride(buf, (s72, 3072), (3072, 1), 'torch.ops.vllm.moe_forward.default')`
- **Fix is in vLLM**, not pytorch. Track at the vLLM repo, close any pytorch issue with `state_reason: not_planned`.

Before filing the upstream issue, also search the vLLM repo for an existing report — community filings can land independently:
```bash
curl -s "https://api.github.com/search/issues?q=repo:vllm-project/vllm+is:issue+<distinctive_signature>"
```

### Step 13 — vLLM PR status comment

When meaningful events happen (a fix lands, a batch of issues filed, an umbrella checklist update), post a comment on the vLLM test PR (e.g. `vllm-project/vllm#40077`) summarizing:

- **Closed upstream**: numbered issues no longer reproducing
- **Newly silent**: candidates for close, awaiting verification
- **Still reproducing**: open numbered issues
- **New**: issues filed in the latest run
- **Dormant**: filed but never re-reproduced

The comment is for human-readable status tracking by the release manager; keep it under ~30 bullet points and link to umbrella, not to every individual issue.

---

## Gotchas observed

- **Don't trust `jobs[*].state` alone.** `failed` + `soft_failed=True` is non-blocking. Always filter both.
- **`waiting_failed`** jobs only mean "upstream I depended on failed" — they aren't independent signal.
- **`started_at=None` + `exit_status=-1` + 0-byte log** = job never ran (infra cancelled/aborted before it started). Don't treat as a real signal — it's an infra event masquerading as `state=failed`. Ignore.
- **"Engine core initialization failed. See root cause above."** is a red herring — the actual exception is logged several lines earlier by the `(EngineCore pid=...)` worker.
- **GPU contention (~1 GiB free on an H100)** can cascade dozens of unrelated tests into `ValueError: Free memory ... less than desired`. If you see this pattern widely, recommend a job rerun before filing; the real failures may be a subset.
- **CUDA OOM in tp=2 / B200 fusion tests** is *also* commonly infra (the runner had 4–5 GiB free at start when 5 GiB was needed). Cross-check the same job on the same-day main build — if main fails the same way with the same OOM signature, it's contention, not torch. Skip filing.
- **Log timestamps differ per infrastructure:** dgxB200 nodes prefix with `_bk;t=…` only; mithril/aws nodes prefix with `[YYYY-MM-DDTHH:MM:SSZ]`. The ANSI-strip + BKT-strip pair handles both.
- **PyPI vs test channel:** `ERROR: No matching distribution found for torch==2.12.0` isn't infra — the release isn't on PyPI yet. Tell the user; don't file a bug.
- **`Python-only Installation` job has multiple unrelated failure modes:** (a) torch not on PyPI — expected, skip. (b) `metadata is still not available after N attempts` / `precompiled wheel for commit X is available` — vLLM's own precompiled-wheel infra hiccup, not torch. Both → ignore.
- **Parallel curl in `while read` needs the token in a shell variable first**, not `$(cat …)` inline — otherwise backgrounded processes race the substitution and log files are 0 bytes.
- **Buildkite REST API rate-limit is 400/min.** A burst of parallel-fetched logs will hit it; expect 161-byte error JSON instead of real logs. Switch to serial fetch (or `sleep 15` between bursts) when rate-limited.
- **`exit_status=125` on multiple B200 jobs simultaneously, all with `nvidia-container-cli: initialization error: driver rpc error: timed out`** = B200 agent driver/container infra issue, not a regression. Recommend rerun, do not file. Often clusters across V1 attention, Fusion E2E, GPQA, LM Eval, MoE Refactor, Spec Decode B200 jobs at once.
- **Same B200 infra cluster wipes out main-build coverage too.** When the *main* daily/nightly builds also have many B200 jobs killed by `exit 125 / nvidia-container-cli` (typical when the agent fleet has a bad day), do NOT use those main builds as a baseline. The pattern "test PR fails this job, main appears not to" is **inconclusive** — main never actually ran the test. ALWAYS ask the user (or release manager) to retry the corresponding main nightly job before drafting a new umbrella issue. Filing without that baseline produced a wrongful issue (#182549, retracted 2026-05-05): same Nemotron-Nano-30B-Fp8 GSM8K accuracy floor failed on both torch 2.11 (after main retry) and torch 2.12, but the torch 2.11 main builds had been killed by the B200 infra issue and looked "passing" by absence.
- **Compile-on vs `--enforce-eager` CI gap:** fake-kernel / Inductor stride bugs only surface when compile is on. Many gpt-oss CI lanes (`tests/evals/gpt_oss/test_gpqa_correctness.py`, `--enforce-eager` parametrizations) bypass torch.compile entirely and never trace the fake kernel. If a custom-op stride mismatch only shows up on the torch-bump test PR, the bug almost certainly exists on main too — vLLM CI is just hiding it. When closing such an issue, mention this gap so vLLM can add coverage.
- **Closed upstream ≠ fixed in CI.** The pytorch test-channel wheel is a snapshot; if the closing commit landed AFTER the wheel was built, the same signature keeps reproducing. Verify with timestamps before reopening — recommend a wheel rebuild instead.
- **`Dockerfile.cpu` seeds `requirements/test/cpu.in` from `requirements/test/cuda.in`** (literal `COPY ... cuda.in cpu.in`), so the top-line `--extra-index-url https://download.pytorch.org/whl/test/cu130` carries over to the CPU build. Combined with `uv pip compile --torch-backend cpu` (which forces stable cpu channel), torch 2.12 wheels go missing. Fix: sed-rewrite the index-url to `whl/test/cpu` AND drop `--torch-backend cpu`.
- **`uv --torch-backend <name>` overrides extra-index-url for torch.** Only stable channels (`cpu`, `cu128`, etc.) are presets — there is no `test-cpu` preset. To pin torch to the test channel, use `--extra-index-url` explicitly (or `UV_EXTRA_INDEX_URL` env) and *don't* pass `--torch-backend`.

---

## Token ownership

Tokens live in the user's home dir only. Never echo them to the conversation, never commit them, never include in issue bodies. If the user ever asks to rotate, remind them to delete the file + revoke at the provider UI.

## Repo routing cheat-sheet

| Error pattern | Repo |
|---|---|
| `torch.library.Library.impl ... already a kernel registered` | pytorch/pytorch |
| `MetaProxy` in `prims.*` / Inductor | pytorch/pytorch |
| `PassManager::run failed` inside `triton/` frames | pytorch/pytorch (triton) |
| `Pointer argument cannot be accessed from Triton` | pytorch/pytorch (triton) |
| `Cannot access data pointer of Tensor (FakeTensor…)` | pytorch/pytorch (AOTAutograd) |
| `_pickle.PicklingError` on triton `launcher` | pytorch/pytorch (triton + AOT cache) |
| `warm_artifacts_saved: got 0`, `KeyError: None` in standalone_compile | pytorch/pytorch (Inductor cache) |
| `assert 'no' == 'yes'` in `test_dynamic_shapes_compilation` | pytorch/pytorch (Dynamo), but rerun first if GPU was OOM |
| `torch.compile with fullgraph=True found no compiled frames` (when `TORCH_COMPILE_DISABLE=1` is in env) | vLLM-side fix usually correct (use `--enforce-eager` instead); upstream interest if behavior change is intentional |
| `RayChannelTimeoutError: System error: Timed out waiting for object available to read` on tp≥2 ray | pytorch/pytorch — likely torch.compile per-worker latency exceeds Ray channel timeout |
| `Failed: Nondeterministic outputs detected: N failed out of M trials` (B200-only) | pytorch/pytorch — Blackwell-specific kernel drift |
| `assert torch.allclose(golden_output, vllm_output, ...)` failure on reward / PRM models | pytorch/pytorch — numerical drift from triton update |
| `compare_two_settings(... cpu-offload-gb ...)` → "Results are not the same" | pytorch/pytorch (CPU↔GPU dequantize parity) |
| GSM8K accuracy collapses to 0.000 (not just degrades) | pytorch/pytorch — likely worker-side crash hidden behind unpickle error |
| `Generated text "X" doesn't match expected pattern "Y"` on Qwen2-VL / Qwen3-VL LoRA | pytorch/pytorch — multimodal LoRA path numerical drift (file separately if different LoRA target) |
| `AssertionError: expected size N==N, stride A==B at dim=0` + `Error in op: torch.ops.vllm.<X>.default` + "incorrect fake (aka meta) kernel" hint | **vllm-project/vllm** — fake kernel registered via `direct_register_custom_op(..., fake_impl=...)` returns wrong shape. Find the registration site and the recent vLLM commit that changed the runtime allocation. Close any pytorch issue with `state_reason: not_planned`. |
| Bulk `exit_status=125` + `nvidia-container-cli: initialization error: driver rpc error: timed out` across many B200 jobs | infra (B200 agent) — recommend rerun, do not file |
| Multi-modal per-model assertions (qwen2_vl, chameleon) | vllm-project/vllm first — may be torch-side once isolated |
| Responses API assertion (`'incomplete' == 'completed'`) | vllm-project/vllm |
| `test_lm_eval_accuracy_v1_engine` — measured below threshold | investigate both — often numerical drift from triton update |
| CUDA OOM in fusion-test parallel runs (~4–5 GiB free at start) | infra; check main same-day to confirm |
