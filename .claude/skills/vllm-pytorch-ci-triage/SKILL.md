---
name: vllm-pytorch-ci-triage
description: Triage a failing vLLM Buildkite CI build for a PyTorch version-bump PR, isolate new regressions vs. pre-existing failures on main by comparing against recent "Full CI run - nightly/daily" builds, classify by root cause, and file one grouped issue per root cause in pytorch/pytorch (linked under an umbrella issue). Use when the user points at a Buildkite build for a torch/triton upgrade and asks "what's broken that isn't broken on main" or "file issues for each failure".
---

# vLLM × PyTorch version-bump CI triage

End-to-end workflow for triaging a vLLM CI run that tests a new torch/triton release and filing upstream issues for the real regressions. Derived from the multi-week triage of vLLM PR #40077 (torch 2.12.0 + triton 3.7.0) starting 2026-04-20 against Buildkite build #62138 → filed 16+ issues under umbrella `pytorch/pytorch#180899` over a series of daily runs (62138 → 62232 → 62495 → 62583 → 62848 → 63095). The workflow handles both first-time triage and ongoing daily monitoring.

The `vllm_pytorch_ci_triage` package is pip-installed in this environment — import
it directly (`from vllm_pytorch_ci_triage... import ...`). Do **not** add
`sys.path.insert(...)`; there is no source checkout path in CI.

---

## Prerequisites

Both tokens must exist on disk with `600` perms. Do NOT paste into chat.

```bash
# Buildkite API token — https://buildkite.com/user/api-access-tokens
# Scopes: read_builds, read_build_logs (parse/diff), plus write_builds if you want
# Step 4 auto-restart to work. A read-only token parses fine but CANNOT retry jobs.
# Must be a member of the `vllm` org.
umask 077 && printf '%s\n' 'bkua_...' > ~/.buildkite_token && chmod 600 ~/.buildkite_token

# GitHub PAT — https://github.com/settings/tokens/new
# Classic token with `public_repo` scope is enough (pytorch/pytorch + vllm-project/vllm are public).
printf '%s\n' 'ghp_...' > ~/.github_vllm_token && chmod 600 ~/.github_vllm_token
```

Shell state does NOT persist between Bash tool calls — always read tokens per-invocation via `$(cat ~/.foo_token)`.

`gh` CLI may not be installed (it wasn't in this env). Use raw `curl` against the REST API.

---

## Inputs the user usually provides

The **target build** (the one under test, running the new torch/triton) comes in one of two shapes:

- **A torch-bump PR build**, e.g. `https://buildkite.com/vllm/ci/builds/62138`, usually with its PR
  (e.g. `vllm-project/vllm#40077`). The build JSON contains the commit, branch, and PR link.
- **A scheduled torch-nightly build on `main`** — when the user says "the most recent torch/pytorch
  nightly CI run" and gives no PR. There is no PR here; the target is the newest `main` build whose
  message is **`Full CI run torch nightly`** (distinct from the stable `Full CI run - nightly`).
  Find it the same way as the baselines in Step 1:

  ```bash
  curl -sH "Authorization: Bearer $TOKEN" \
    "https://api.buildkite.com/v2/organizations/vllm/pipelines/ci/builds?branch=main&per_page=100" \
  | grep -B2 '"Full CI run torch nightly"'   # newest match is the target
  ```

Also usually provided:

- An umbrella issue (e.g. `pytorch/pytorch#180899`) — if present, append new issues to its checklist

---

### Step 1 — Find the most recent full builds on main

The full builds are commits on `main` whose message starts with `Full CI run - nightly` or `Full CI run - daily`. Pull the last ~week:

```bash
curl -sH "Authorization: Bearer $TOKEN" \
  "https://api.buildkite.com/v2/organizations/vllm/pipelines/ci/builds?branch=main&created_from=YYYY-MM-DDT00:00:00Z&per_page=100" \
  > /tmp/main_builds.json
```

Grep for `"Full CI run - nightly"` and `"Full CI run - daily"` in the message, then fetch each build's JSON with the same endpoint as step 1.

Match the hyphen: `Full CI run - nightly` (stable-torch baseline) is a **different** build from
`Full CI run torch nightly` (the torch-nightly target from the Inputs section). Never pass the
torch-nightly build as its own baseline.

---

## Step 2: Parse and compare (runs upstream — not you)

In the scheduled workflow this has already run before you start. The
`torchci.vllm_torch_nightly_triage` job (on the runner, holding the ClickHouse and
Buildkite secrets) does discovery, the job-level A/B, and log parsing, then writes the
files you read in Step 3 — `report.md`, `report.json`, `cluster-logs/*.log`. You have
no ClickHouse or Buildkite access and do not run this step yourself.

How it decides regressions (job-level A/B over ClickHouse job metadata): it pairs the
newest `Full CI run torch nightly` build with its same-commit, same-slot
`Full CI run - nightly` / `- daily` baseline, then buckets each job:

- `regressed` — fails on torch nightly, passes on the baseline.
- `both` — fails on both (pre-existing, not torch).
- `baseline_only` — fails only on the baseline.

Only `regressed` clusters get a log fetched, parsed, and written to `cluster-logs/`.

---

## Step 3: Read the cluster logs

You do not run the parser or fetch anything — Step 2 already produced the files. Your
tools are `Read`, `Glob`, `Grep`, `Write`; there is no Python execution and no
Buildkite / ClickHouse access. Read what is on disk in the triage input dir:

- `report.md` — the A/B summary and the regressed clusters (see Step 5).
- `report.json` — the same, structured: `torch_nightly_build`, `baseline_build`,
  `commit`, and the `regressed` / `both` job lists.
- `cluster-logs/*.log` — one representative log per regressed cluster, ANSI-stripped.T
   This is your primary root-cause material.

### Cluster-log artifact format

Every file opens with a header:

```
# cluster: <cluster key>
# job: <job name>
# url: <buildkite job url>
# state: <state> exit_status: <n>
```

**Parsed form** — pytest failures were extracted. The header is followed by
`# parsed N failing test(s)` and one block per test:

```
## tests/kernels/test_deepgemm.py::test_gemm
exception_class: RuntimeError
test_is_infra: false

def test_gemm():
>       run_gemm()
E       RuntimeError: CUDA driver init failed
test_deepgemm.py:42: RuntimeError
```

- `## <test_id>` — pytest node ID.
- `exception_class` — exception type from the FAILURES section.
- `test_is_infra` — per-test transient-infra tag (CUDA-init, `exit status 137`,
  `Free memory … less than desired`, …).
- Everything after the blank line is the **raw section body** (the traceback): source
  lines, `E` error lines, file refs, chained-exception connectors. This is the
  `exception_chain` Step 6 refers to — your primary content for root cause.

**Fallback form** — no pytest failures were parsed (a build/crash before pytest ran,
an empty parse, or the parser raising). The header is followed by:

```
# parse_fallback: true (raw tail; scan upward for the real error)
# parse_error: <message>        # only present if the parser raised
# job_is_infra: <bool>
# showing last <k> of <n> lines

<the last k lines of the cleaned log>
```

- `job_is_infra` — the fallback's job-level equivalent of `test_is_infra`.
- The tail is the end of the whole cleaned log; the real error is usually a few lines
  above the bottom. Scan **upward** past wrappers like
  `Engine core initialization failed. See root cause above.` — that line is never the
  root cause.

A fallback file is the old "non-pytest failure" case: Docker image build failure,
compile error, import-time segfault. It has no pytest node ID — refer to it by its
cluster / job name, and treat it as novel (baseline comparison already happened at the
job level in Step 2).

**Infra is not a torch regression.** A cluster whose failures are all
`test_is_infra: true` (or `job_is_infra: true`) is still present in the input; do not
root-cause it as a regression — call it out as infra. (The cron agent files nothing and
reruns nothing; job retry is the manual hand-run path in Step 4.)

### Step 4 — Auto-restart transient-infra failures (do this automatically; do NOT file)

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

**Within-build retry is infra-recovery, not a reproducibility test** (Step 13.1): retrying an
infra job to get it onto a healthy agent is correct; but a retry that fails again does NOT
prove a real regression (same image/agents). Only a *fresh build* proves reproducibility.

**Log what you restarted.** Emit a per-run list of `{job, signature, retry_status}` and the
skipped set with reasons — silent restarts hide a persistently-broken fleet. If the SAME
transient-infra signature dominates two consecutive runs, escalate: recommend a full rebuild
on a healthy fleet rather than another round of same-build retries.


## Step 5: NEW vs pre-existing

Classification is decided **upstream** by the torch-nightly vs same-commit-baseline
A/B. Each job is already bucketed in the report:

- `regressed` — fails on torch nightly, passes on the baseline → new, torch-attributable.
- `both` — fails on both → `PRE_EXISTING`, not torch. No root-cause analysis needed.
- `baseline_only` — fails only on the baseline → ignore.

Rate `new_failure_confidence` (1-5) per group from its bucket plus the infra /
agent-concentration evidence in the report. For scale definitions, see
[CONFIDENCE.md](CONFIDENCE.md).

## Step 6: Group remaining failures by root cause

Only genuinely new failures reach this step.

ONE group per root cause, not per job. From real data: 22 failing jobs
grouped into 10 root causes.

Use `exception_chain` (the raw traceback) as your primary source for root cause
analysis. Use `exception_class` as a quick identifier.
Same root cause across jobs = same group.

Rate `shared_root_cause_confidence` (1-5) per member as you assign it to a group.

For grouping patterns, see [GROUPING.md](GROUPING.md).

## Step 7: Classify each group

Match each group's exception pattern against the routing cheat-sheet in
[ROUTING.md](ROUTING.md). Map repo to classification:

- `pytorch/pytorch` → `TORCH_REGRESSION`
- `pytorch/pytorch (triton)` → `TRITON_REGRESSION`
- `vllm-project/vllm` → `VLLM_REGRESSION`

Determine `area_tag` from the exception chain and stack frames in context.

Rate per group as you route:
- `classification_confidence` (1-5) — how sure the routing is correct
- `new_failure_confidence` (1-5) — how confident this is genuinely new

For scale definitions, see [CONFIDENCE.md](CONFIDENCE.md).

### Step 8 — Draft and confirm before posting

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

### Step 9 — Post via GitHub REST API

```bash
curl -s -X POST \
  -H "Authorization: Bearer $(cat ~/.github_vllm_token)" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/pytorch/pytorch/issues \
  -d @/tmp/issue_body.json
```

**JSON body shape:** `{"title": "...", "body": "...markdown..."}`. Labels and assignees intentionally omitted — let maintainers triage.

### Step 10 — Link to umbrella

Fetch the umbrella body, find the last numbered checklist line (`^\d+\. \[[ x]\] https://github.com/pytorch/pytorch/issues/\d+`), insert the new link(s) with incremented numbers, PATCH:

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer $(cat ~/.github_vllm_token)" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/pytorch/pytorch/issues/<UMBRELLA> \
  -d "{\"body\": <escaped new body>}"
```

Always re-fetch the umbrella body before patching — other people may have edited it in between.

### Step 11 — Post-filing corrections

Titles and bodies can be bulk-PATCHed; simple string replacements work fine:
```python
new_title = old_title.replace('pytorch-triton', 'triton')
new_body  = old_body.replace('pytorch-triton', 'triton')
```

### Step 12 — Recurring runs (daily monitoring)

Once the umbrella exists, subsequent test-PR builds are *not* "open new issues per failing job" — they're **delta analysis**. For each new build:

1. Re-fetch the umbrella body and the JSON of every linked issue. Cache issue states (open/closed) keyed by number.
2. **Auto-restart transient-infra failures first (Step 4).** Before classifying real signal,
   retry every blocking-failed job that positively matches a transient-infra signature
   (CUDA-driver-init storm, nvidia-container-cli, exit 125, docker setup-hook, ECR rate-limit),
   skipping missing-image (`manifest unknown`), real regressions, and benign modes. This both
   recovers the run and prevents infra noise from polluting the delta. Record the restarted vs
   skipped lists in the run report/state.
3. Match each hard-failed job in the new build against tracked-issue signatures (build a regex map from issue titles/bodies). Three buckets:
   - **Still reproducing**: tracked issue still hits → no new issue. If the user wants, PATCH the existing issue body to append the new build link to a Reproducibility section.
   - **Newly silent**: previously-failing job/test now passes. Don't immediately close — wait for ≥2 consecutive runs of "silent" before suggesting close.
   - **Unmatched**: failing job whose signature isn't in any tracked issue. Cross-check against ≥3 main builds (per Step 1). If new on the torch-bump branch, draft + post a fresh issue and append to umbrella.
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

### Step 13 — "Closed upstream but still reproducing" check

When a tracked issue's state flips to `closed` but the same signature keeps appearing in subsequent builds, the fix is in pytorch `main` but not yet in the test-channel wheel that vLLM CI pulls. Verify by comparing timestamps:

```bash
# Closing commit timestamp from the issue's timeline
gh_close = events[event=='closed'].created_at  # commit that auto-closed
# Build start time on the test branch
build.created_at
# Test-channel wheel build timestamp (look at torch dist URL or PEP-503 index page)
```

If `build.created_at > closing_commit.created_at` but the failure persists, the wheel predates the fix. Recommendation: cherry-pick the fix to the release branch and rebuild the RC wheel. Don't reopen the issue — it really is fixed in main.

### Step 13.1 — A within-build retry is NOT a reproducibility test

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

### Step 13.2 — Reopen vs file new

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

### Step 14 — vLLM PR status comment

When meaningful events happen (a fix lands, a batch of issues filed, an umbrella checklist update), post a comment on the vLLM test PR (e.g. `vllm-project/vllm#40077`) summarizing:

- **Closed upstream**: numbered issues no longer reproducing
- **Newly silent**: candidates for close, awaiting verification
- **Still reproducing**: open numbered issues
- **New**: issues filed in the latest run
- **Dormant**: filed but never re-reproduced

The comment is for human-readable status tracking by the release manager; keep it under ~30 bullet points and link to umbrella, not to every individual issue.

---

## Gotchas the parser does NOT catch

The parser filters soft-fails, `waiting_failed`, never-ran jobs, marker/timestamp noise, and tags transient-infra signatures. The following are **not** filtered — apply them yourself when reading the `cluster-logs/*.log` files:

- **PyPI vs test channel:** `ERROR: No matching distribution found for torch==2.12.0` isn't infra — the release isn't on PyPI yet. It arrives as a non-pytest failure (treated as novel). Tell the user; don't file a bug.
- **`Python-only Installation` job has multiple unrelated failure modes:** (a) torch not on PyPI — expected, skip. (b) `metadata is still not available after N attempts` / `precompiled wheel for commit X is available` — vLLM's own precompiled-wheel infra hiccup, not torch. Both arrive as non-pytest failures (treated as novel) → ignore.
- **An infra-killed baseline job is not a baseline.** The A/B buckets trust the baseline job's state. A baseline job hit by `exit 125` / `nvidia-container-cli` (or otherwise never running the tests) still lands in `BAD_STATES`, so the same job failing on torch nightly is bucketed `both` (pre-existing) — **masking a real regression** rather than surfacing it. (The failing baseline was infra, not the same test.) When the baseline build has many B200 jobs killed by infra, do NOT trust a `both` verdict on those jobs; the pair is **inconclusive** because the baseline never ran the test. Ask the user (or release manager) to retry the corresponding baseline job before concluding anything. The inverse mistake — treating a broken baseline as if the test passed there — produced a wrongful issue (#182549, retracted 2026-05-05).
- **Compile-on vs `--enforce-eager` CI gap:** fake-kernel / Inductor stride bugs only surface when compile is on. Many gpt-oss CI lanes (`tests/evals/gpt_oss/test_gpqa_correctness.py`, `--enforce-eager` parametrizations) bypass torch.compile entirely and never trace the fake kernel. If a custom-op stride mismatch only shows up on the torch-bump test PR, the bug almost certainly exists on main too — vLLM CI is just hiding it. When closing such an issue, mention this gap so vLLM can add coverage.
- **`Dockerfile.cpu` seeds `requirements/test/cpu.in` from `requirements/test/cuda.in`** (literal `COPY ... cuda.in cpu.in`), so the top-line `--extra-index-url https://download.pytorch.org/whl/test/cu130` carries over to the CPU build. Combined with `uv pip compile --torch-backend cpu` (which forces stable cpu channel), torch 2.12 wheels go missing. Fix: sed-rewrite the index-url to `whl/test/cpu` AND drop `--torch-backend cpu`.
- **`uv --torch-backend <name>` overrides extra-index-url for torch.** Only stable channels (`cpu`, `cu128`, etc.) are presets — there is no `test-cpu` preset. To pin torch to the test channel, use `--extra-index-url` explicitly (or `UV_EXTRA_INDEX_URL` env) and *don't* pass `--torch-backend`.

---
