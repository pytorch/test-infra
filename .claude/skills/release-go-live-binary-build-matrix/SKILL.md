---
name: release-go-live-binary-build-matrix
description: Update tools/scripts/generate_binary_build_matrix.py when a PyTorch release goes live. Advances CURRENT_STABLE_VERSION to the new stable, promotes the release-channel CUDA/ROCm arches to match the candidate/test channel, and regenerates the JSON test fixtures. Triggered by mentions of "release go live", "advance stable version", "promote release matrix", or "update binary build matrix" for a new PyTorch X.Y release.
---

# Release Go-Live: Binary Build Matrix

Updates `tools/scripts/generate_binary_build_matrix.py` and the associated test fixtures when a PyTorch release goes live. This mirrors prior PRs such as:
- `Release 2.10 go live. Update release matrix (#7668)`
- `Release 2.11 promotion script changes (#7868)`
- `Release 2.12 go live. Update release matrix (#8070)`

## When to use this skill

Use when the user asks to:
- Advance stable version to X.Y.0 in the binary build matrix
- Promote release CUDA/ROCm arches now that release X.Y is going live
- Update `generate_binary_build_matrix.py` for a new PyTorch release
- Do "release go live" changes

## Target files

| File | Why |
|------|-----|
| `tools/scripts/generate_binary_build_matrix.py` | Source of truth for version + channel arches |
| `tools/tests/assets/build_matrix_*.json` | Snapshot fixtures (compact JSON, must match script output) |
| `tools/tests/update_test_assets.sh` | Regeneration script (canonical) |
| `tools/tests/test_generate_binary_build_matrix.py` | Test runner |

## Instructions

### Step 1: Determine the new stable version

Ask the user (if not clear) what version is going live (e.g. `2.12.0`). The current state usually looks like:

```python
CURRENT_NIGHTLY_VERSION = "2.13.0"
CURRENT_CANDIDATE_VERSION = "2.12.0"   # about to become stable
CURRENT_STABLE_VERSION   = "2.11.0"    # being replaced
```

So a "2.12 go live" advances `CURRENT_STABLE_VERSION` to match `CURRENT_CANDIDATE_VERSION`. Do NOT touch `CURRENT_NIGHTLY_VERSION` or `CURRENT_CANDIDATE_VERSION` in this PR — those are advanced by separate PRs (e.g. `Update nightly version to X.Y.Z`, `[Release X.Y] advance candidate version`).

### Step 2: Advance CURRENT_STABLE_VERSION

In `tools/scripts/generate_binary_build_matrix.py`, change the single line:

```python
CURRENT_STABLE_VERSION = "<old>"
```

to the new stable version.

### Step 3: Promote release-channel arches to match test

Compare the three channels in each arches dict:

```python
CUDA_ARCHES_DICT = {
    "nightly": [...],
    "test":    [...],
    "release": [...],   # promote this to match "test"
}

ROCM_ARCHES_DICT = {
    "nightly": [...],
    "test":    [...],
    "release": [...],   # promote this to match "test"
}
```

If `release` differs from `test`, update `release` to match `test`. This is the actual "what CUDA/ROCm versions ship with this release" decision — the candidate-channel arches that survived the release cycle become the official release arches.

Also check `STABLE_CUDA_VERSIONS` — usually already aligned across channels, but verify all three entries point at the same default for the new release.

### Step 4: Regenerate test fixtures (MUST use the shell script)

The fixtures are compact (single-line) JSON. The script `tools/tests/update_test_assets.sh` is the canonical regenerator. Do NOT use `python3 -m tools.tests.test_generate_binary_build_matrix --update-reference-files` — that pretty-prints with `indent=2` and produces a massive churn diff that does not match the file format on `main`.

Run from the repo root (note the script uses relative paths so cd matters):

```bash
cd tools/tests
python3 ../scripts/generate_binary_build_matrix.py --build-python-only disable --with-xpu disable > assets/build_matrix_linux_wheel_cuda.json
python3 ../scripts/generate_binary_build_matrix.py --build-python-only disable --with-rocm disable --with-xpu disable > assets/build_matrix_linux_wheel_cuda_norocm.json
python3 ../scripts/generate_binary_build_matrix.py --build-python-only disable --with-cpu disable --with-xpu disable > assets/build_matrix_linux_wheel_nocpu.json
python3 ../scripts/generate_binary_build_matrix.py --build-python-only disable --with-cpu disable --with-rocm disable --with-xpu enable > assets/build_matrix_linux_wheel_xpu.json
python3 ../scripts/generate_binary_build_matrix.py --build-python-only disable --operating-system="macos" --with-cuda disable --with-rocm disable > assets/build_matrix_macos_wheel.json
python3 ../scripts/generate_binary_build_matrix.py --build-python-only disable --operating-system="windows" > assets/build_matrix_windows_wheel_cuda.json
python3 ../scripts/generate_binary_build_matrix.py --build-python-only disable --with-rocm disable --with-cuda disable --operating-system="windows" > assets/build_matrix_windows_wheel_xpu.json
```

Skip the `conda` lines from `update_test_assets.sh` — `--package-type conda` is broken on `main` (noted in PR #8065) and the conda fixtures are no longer maintained.

### Step 5: Run tests

```bash
python3 -m tools.tests.test_generate_binary_build_matrix
```

Expected: `Ran 7 tests in <time>s OK`.

### Step 6: Verify the diff is minimal

`git diff --stat` should show roughly:
- `tools/scripts/generate_binary_build_matrix.py`: ~4 lines (stable version + release arches list)
- 7 fixture JSON files: 1 line each (single-line files, change is in-place)

Sanity check: the only diff in fixtures should be `"stable_version": "<old>"` → `"stable_version": "<new>"`. If a fixture has multi-line / pretty-printed diff, you used the wrong regenerator — revert with `git checkout upstream/main -- tools/tests/assets/` and re-run Step 4.

If the CUDA release arches changed, expect new entries in fixtures (e.g. new `cu132` rows when adding `13.2` to release).

### Step 7: Commit and PR

Suggested commit/PR title pattern (matches history):

```
Release X.Y go live. Update release matrix
```

PR body should call out:
- Advance `CURRENT_STABLE_VERSION` from `<old>` to `<new>`
- (If applicable) Advance `CUDA_ARCHES_DICT["release"]` / `ROCM_ARCHES_DICT["release"]`
- Regenerate test fixtures via `tools/tests/update_test_assets.sh`

## Common pitfalls

- **Don't pretty-print fixtures.** The `--update-reference-files` test flag writes `indent=2`. The fixtures on `main` are single-line. Always use the shell script approach.
- **Don't touch nightly/candidate versions.** Those are advanced by separate PRs in the release cycle.
- **`upstream` is `pytorch/test-infra`.** Branch from `upstream/main`, push to `origin` (your fork), open the PR against `pytorch/test-infra:main`.
- **Stash unrelated WIP.** `generate_binary_build_matrix.py` changes should go in a clean branch off `upstream/main` — don't pile them onto an unrelated feature branch.
