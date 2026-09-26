---
name: release-day-checklist
description: Drive the PyTorch RC-to-GA (go-live) release execution checklist end to end - build/validate the final RC, stage and promote wheels to PyPI, promote to download.pytorch.org, publish Docker images, and track docs/tags/release-notes/announcement steps. Orchestrates the reusable release workflows in pytorch/test-infra and the sibling release-* skills, and maintains a GitHub tracking issue that it ticks as steps complete. Triggered by mentions of "release checklist", "release day", "go live", "promote the release", or "execute the release".
---

# Release Day (Go-Live) Checklist

Runbook for executing a PyTorch release from the final Release Candidate through General Availability. This replaces the manually-maintained "Release X.Y.Z Checklist" spreadsheet with a self-ticking GitHub tracking issue, and orchestrates the automation that already exists in `pytorch/test-infra` rather than reimplementing it.

This skill is the **orchestration / runbook** layer. Execution happens in GitHub Actions workflows (documented in [`pytorch/pytorch:RELEASE.md`](https://github.com/pytorch/pytorch/blob/main/RELEASE.md#release-automation-workflows-in-pytorchtest-infra)) and in the sibling `release-*` skills. Each step below is labeled:

- **auto** — a workflow does the work; run it and verify.
- **gate** — an automated validation must pass before proceeding.
- **manual** — a human must act (external dependency, tag push, comms); the skill only tracks it.

## When to use this skill

Use when the user asks to:
- Execute / drive the release checklist for a PyTorch release (e.g. "run the 2.13.0 release checklist")
- Do "release day" / "go live" tasks after the final RC is cut
- Promote a release: stage and push wheels to PyPI, promote to download.pytorch.org, publish Docker images
- Track the status of an in-progress release

Do **not** use this skill for pre-branch-cut or cherry-pick work — use `release-create-tracker-issue` and `release-cherry-pick-missing-reverts` for that.

## Prerequisites

- The release branch (`release/[major].[minor]`) is cut and the final RC tag is (or is about to be) pushed.
- You have (or the release manager has) access to trigger `workflow_dispatch` workflows in `pytorch/test-infra` and to the `promote-env` / `pytorchbot-env` environments.
- AWS is reachable (`AWS_PROFILE=fbossci aws ...`) for staging/promotion verification.

## Step 1: Collect parameters

Ask only for what is missing.

| Parameter | Example | How to obtain |
|-----------|---------|---------------|
| **Release version** | `2.13.0` | From the user / release tracker |
| **Branch version** | `2.13` | Drop the patch |
| **Is this a patch release?** | no | Patch releases skip the compatibility-matrix step |
| **Tracking issue** | URL | Existing checklist issue, or create one in Step 2 |

## Step 2: Create or locate the tracking issue

If no tracking issue exists, generate one from the template in [`checklist-template.md`](checklist-template.md) (rendered checkbox list of the steps below) and open it in `pytorch/pytorch` titled `[v.{VERSION}] Release Day Checklist` with label `release tracker`. Show the body to the user before creating (opening an issue is outward-facing).

As each step completes, check its box in the issue and append the workflow-run URL (mirrors how the spreadsheet recorded run links in the Details column).

## Step 3: Build & validate the final RC

| # | Step | Type | How | Verify |
|---|------|------|-----|--------|
| 1 | Build and test RC | auto | Push the `v{VERSION}-rc{N}` tag (see RELEASE.md "Drafting RCs"); binary build workflows trigger | All builds green on [HUD](https://hud.pytorch.org/hud/pytorch/pytorch/release%2F{BRANCH}) |
| 2 | Metadata validation of final RC | gate | Confirm built matrix (Python versions, CUDA/ROCm arches, OSes) matches the release matrix from [`generate_release_matrix.yml`](https://github.com/pytorch/test-infra/blob/main/.github/workflows/generate_release_matrix.yml) | Matrix diff empty |
| 3 | Run smoke tests for RC | auto | [`validate-binaries.yml`](https://github.com/pytorch/test-infra/blob/main/.github/workflows/validate-binaries.yml) with `channel=test`, `os=all` | Workflow green |
| 4 | Build & release Triton to PyPI | manual | External request to OpenAI (include the triton pin hash). See RELEASE.md "Triton dependency for the release" | Triton on [pypi.org/project/triton](https://pypi.org/project/triton/) + release notes published |
| 5 | Validate wheels | gate | [`validate-binaries.yml`](https://github.com/pytorch/test-infra/blob/main/.github/workflows/validate-binaries.yml) (test channel) across linux/windows/macos-arm64/aarch64 | Green |

## Step 4: PyPI staging → production

| # | Step | Type | How | Verify |
|---|------|------|-----|--------|
| 6 | Stage one set of wheels to PyPI (core + domains, linux/windows/mac) | auto | `release/pypi/promote_pypi_to_staging.sh` or [`release-stage-pypi.yml`](https://github.com/pytorch/test-infra/blob/main/.github/workflows/release-stage-pypi.yml) | Wheels present in staging bucket |
| 7 | Inspect staged PyPI wheels | gate | Check each wheel: size ≤ PyPI limit, correct metadata (`Requires-Dist`, tags), platform-tag coverage. See the pitfalls note on PyPI size limits | All checks pass |
| 8 | Promote wheels to PyPI production (core + domains) | manual→auto | [`release-pypi.yml`](https://github.com/pytorch/test-infra/blob/main/.github/workflows/release-pypi.yml) / `release/promote.sh`. **PyPI upload is one-shot — take extreme care** | Packages live on PyPI |
| 9 | Recompute prod checksums for torch | auto | [`release-post-promotion.yml`](https://github.com/pytorch/test-infra/blob/main/.github/workflows/release-post-promotion.yml) | Workflow green |
| 10 | Validate PyPI packages (core, vision, audio) | gate | [`validate-binaries.yml`](https://github.com/pytorch/test-infra/blob/main/.github/workflows/validate-binaries.yml) with `channel=release` (pip/PyPI install) | Green |

> **NOTE:** Promotion to PyPI can only be done once per version (see https://github.com/pypi/warehouse/issues/726). Always dry-run first (`dryrun=enabled`, the default) and inspect output before `dryrun=disabled`.

## Step 5: Docker images

| # | Step | Type | How | Verify |
|---|------|------|-----|--------|
| 11 | Validate docker builds | gate | [`validate-docker-images.yml`](https://github.com/pytorch/test-infra/blob/main/.github/workflows/validate-docker-images.yml) with `channel=release` | GPU smoke tests green |
| 12 | Rebuild, test, upload docker to Docker Hub | auto | [`release-docker.yml`](https://github.com/pytorch/test-infra/blob/main/.github/workflows/release-docker.yml) (`pytorch_version={VERSION}`, `dry_run=false`) | Images on Docker Hub |
| 13 | Validate `create_release.yml` succeeded | gate | Check the [pytorch/pytorch create_release run](https://github.com/pytorch/pytorch/blob/main/.github/workflows/create_release.yml) | Run green (source tarball + assets attached to the GitHub release) |

## Step 6: Website, install matrix & docs

| # | Step | Type | How | Verify |
|---|------|------|-----|--------|
| 14 | Update binary install commands / installation matrix | auto (PR) | Auto-generated PR to `pytorch.github.io` (`published_versions.json`, `quick-start-module.js`). See RELEASE.md "Modify release matrix" | PR merged on release day |
| 15 | Update WordPress with install commands | manual | CMS edit | — |
| 16 | Update previous-versions page | manual (PR) | PR to `pytorch.github.io` get-started/previous-versions | Merged |
| 17 | Push doc builds | auto/manual | Automatic for `pytorch/pytorch`; manual for libraries | Docs live at docs.pytorch.org |
| 18 | Docs redirects, remove prior release from search indexing, add prior release to previous versions | manual (PR) | PRs to `pytorch/docs` | Merged |
| 19 | Push tutorials | manual | Merge in `pytorch/tutorials` | Published |
| 20 | Update compatibility matrix (core/vision/audio) | manual (PR) | **Minor releases only — skip for patch.** PR to `RELEASE.md` + get-started | Merged |

## Step 7: Tags, release notes & announcements

| # | Step | Type | How | Verify |
|---|------|------|-----|--------|
| 21 | Push final tag to core | manual | `git tag v{VERSION} && git push origin v{VERSION}` (human release gate) | Tag on GitHub |
| 22 | Push final tag to vision (+ other domains) | manual | Same, per domain | Tags pushed |
| 23 | Publish PyTorch release notes | manual | GitHub release for `v{VERSION}` | Published |
| 24 | Publish domain release notes (torchvision, etc.) | manual | Per-repo GitHub releases | Published |
| 25 | Open Colab version-update issue | manual→scriptable | Open issue in [googlecolab/colabtools](https://github.com/googlecolab/colabtools); ping Colab team on Slack | Issue open |
| 26 | Publish blog post(s), feature on website, share on social (X/FB/LinkedIn) | manual | Comms | Live |
| 27 | Announce on Dev Discuss and Slack; share with reporters | manual | Comms | Posted |

## Step 8: Wrap up

Confirm every box in the tracking issue is checked (or explicitly marked N/A for patch releases). Post a short completion summary to the issue with the key run links.

## Composition with sibling skills

- **`release-go-live-binary-build-matrix`** — run this (Step 3 area) to advance `CURRENT_STABLE_VERSION` and promote release arches in `generate_binary_build_matrix.py` when the release goes live.
- **`release-create-validation-issue`** — create the release validation issue that this checklist's gate steps feed into.
- **`release-create-tracker-issue`** — the cherry-pick tracker cut at branch-cut time (upstream of this checklist).

## Notes & pitfalls

- **PyPI is one-shot.** Never run promotion with `dryrun=disabled` until the staged wheels have passed Step 7 inspection. There is no undo.
- **Dry-run everything first.** All promotion workflows default to `dryrun=enabled` — keep that default until verified.
- **Patch releases skip** the compatibility-matrix update (Step 20) and may skip docstring/doc-version steps; ask if unsure.
- **`upstream` is `pytorch/test-infra`** for workflow changes; release tags and notes are pushed in the respective product repos (`pytorch/pytorch`, `pytorch/vision`, ...).
- Keep the tracking issue as the single source of truth; record each workflow-run URL next to its checked item, exactly as the spreadsheet's Details column did.
- Step order matters: staging (6) → inspect (7) → production (8) → validate (10). Do not promote to production before the staging inspection gate passes.
