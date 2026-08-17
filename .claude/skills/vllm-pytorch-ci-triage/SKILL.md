---
name: vllm-pytorch-ci-triage
description: Root-cause a vLLM torch-nightly CI regression report. Reads the pre-fetched, ANSI-stripped cluster logs from the triage artifact, identifies the real exception per regressed cluster, groups clusters by shared root cause, routes each cause to pytorch/pytorch, infra, or vllm-project/vllm, and writes findings.md / findings.json. Inputs are produced upstream; it has no Buildkite/ClickHouse access, files no issues, and retries no jobs. Use in the vLLM torch-nightly triage cron's root-cause step.
---

# vLLM × PyTorch torch-nightly CI root-cause

Read-only root-cause analysis for the vLLM torch-nightly triage cron. The upstream
`triage` job runs the A/B (torch nightly vs same-commit baseline), parses the logs, and
hands off artifacts; this skill reads that artifact, root-causes each regressed
cluster, groups by shared cause, routes each cause to the right repo, and writes its
findings to `findings.md` / `findings.json`. It has no Buildkite/ClickHouse access, files
no issues, and retries no jobs — tools are `Read`, `Glob`, `Grep`, `Write`.

Routing knowledge derived from the multi-week triage of vLLM PR #40077 (torch 2.12.0 +
triton 3.7.0), which filed 16+ issues under umbrella `pytorch/pytorch#180899`.

---

## Step 1: Read the cluster logs

The upstream `triage` job already produced the files — you do not run the parser or
fetch anything. Your tools are `Read`, `Glob`, `Grep`, `Write`; there is no Python
execution and no Buildkite / ClickHouse access. Read what is on disk in the triage input
dir:

- `report.md` — the A/B summary and the regressed clusters (see Step 2).
- `report.json` — the same, structured: `torch_nightly_build`, `baseline_build`,
  `commit`, and the `regressed` / `both` job lists.
- `cluster-logs/*.log` — one representative log per regressed cluster, ANSI-stripped.
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
  `exception_chain` Step 3 refers to — your primary content for root cause.

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
cluster / job name, and treat it as novel (baseline comparison already happened upstream
at the job level).

**Infra is not a torch regression.** A cluster whose failures are all
`test_is_infra: true` (or `job_is_infra: true`) is still present in the input; do not
root-cause it as a regression — call it out as infra. The agent files nothing and reruns
nothing.

## Step 2: NEW vs pre-existing

Classification is decided **upstream** by the torch-nightly vs same-commit-baseline
A/B. Each job is already bucketed in the report:

- `regressed` — fails on torch nightly, passes on the baseline → new, torch-attributable.
- `both` — fails on both → `PRE_EXISTING`, not torch. No root-cause analysis needed.
- `baseline_only` — fails only on the baseline → ignore.

Rate `new_failure_confidence` (high/med/low) per group from its bucket plus the infra /
agent-concentration evidence in the report. For scale definitions, see
[CONFIDENCE.md](CONFIDENCE.md).

## Step 3: Group remaining failures by root cause

Only genuinely new failures reach this step.

ONE group per root cause, not per job. From real data: 22 failing jobs
grouped into 10 root causes.

Use `exception_chain` (the raw traceback) as your primary source for root cause
analysis. Use `exception_class` as a quick identifier.
Same root cause across jobs = same group.

Rate `shared_root_cause_confidence` (high/med/low) per member as you assign it to a group.

For grouping patterns, see [GROUPING.md](GROUPING.md).

## Step 4: Classify each group

Match each group's exception pattern against the routing cheat-sheet in
[ROUTING.md](ROUTING.md). Its **Routing** column is one of the three canonical values
(`pytorch/pytorch` | `vllm-project/vllm` | `infra`) — the same set the triage workflow
emits. Map routing to classification:

- `pytorch/pytorch` → `TORCH_REGRESSION`
- `vllm-project/vllm` → `VLLM_REGRESSION`
- `infra` → not a regression — call it out as infra and do not file (see Step 1)

For scale definitions, see [CONFIDENCE.md](CONFIDENCE.md).

## Gotchas the parser does NOT catch

The parser filters soft-fails, `waiting_failed`, never-ran jobs, marker/timestamp noise, and tags transient-infra signatures. The following are **not** filtered — apply them yourself when reading the `cluster-logs/*.log` files:

- **PyPI vs test channel:** `ERROR: No matching distribution found for torch==2.12.0` isn't infra — the release isn't on PyPI yet. It arrives as a non-pytest failure (treated as novel). Note it in the findings; it's not a bug to root-cause.
- **`Python-only Installation` job has multiple unrelated failure modes:** (a) torch not on PyPI — expected, skip. (b) `metadata is still not available after N attempts` / `precompiled wheel for commit X is available` — vLLM's own precompiled-wheel infra hiccup, not torch. Both arrive as non-pytest failures (treated as novel) → ignore.
- **An infra-killed baseline job is not a baseline.** The A/B buckets trust the baseline job's state. A baseline job hit by `exit 125` / `nvidia-container-cli` (or otherwise never running the tests) still lands in `BAD_STATES`, so the same job failing on torch nightly is bucketed `both` (pre-existing) — **masking a real regression** rather than surfacing it. (The failing baseline was infra, not the same test.) When the baseline build has many B200 jobs killed by infra, do NOT trust a `both` verdict on those jobs; the pair is **inconclusive** because the baseline never ran the test. Flag it as inconclusive and recommend retrying the corresponding baseline job rather than concluding anything. The inverse mistake — treating a broken baseline as if the test passed there — produced a wrongful issue (#182549, retracted 2026-05-05).
- **Compile-on vs `--enforce-eager` CI gap:** fake-kernel / Inductor stride bugs only surface when compile is on. Many gpt-oss CI lanes (`tests/evals/gpt_oss/test_gpqa_correctness.py`, `--enforce-eager` parametrizations) bypass torch.compile entirely and never trace the fake kernel. If a custom-op stride mismatch only shows up on the torch-bump test PR, the bug almost certainly exists on main too — vLLM CI is just hiding it. Call out this coverage gap in the findings.
- **`Dockerfile.cpu` seeds `requirements/test/cpu.in` from `requirements/test/cuda.in`** (literal `COPY ... cuda.in cpu.in`), so the top-line `--extra-index-url https://download.pytorch.org/whl/test/cu130` carries over to the CPU build. Combined with `uv pip compile --torch-backend cpu` (which forces stable cpu channel), torch 2.12 wheels go missing. Fix: sed-rewrite the index-url to `whl/test/cpu` AND drop `--torch-backend cpu`.
- **`uv --torch-backend <name>` overrides extra-index-url for torch.** Only stable channels (`cpu`, `cu128`, etc.) are presets — there is no `test-cpu` preset. To pin torch to the test channel, use `--extra-index-url` explicitly (or `UV_EXTRA_INDEX_URL` env) and *don't* pass `--torch-backend`.

---
