---
name: release-update-docker-image-pin
description: Pin (or re-pin) the Linux manywheel builder docker images used by the nightly/release binary build workflows in pytorch/pytorch to a fixed .ci/docker build. Takes the release version (e.g. 2.13) as input. Updates DOCKER_IMAGE_PIN in .github/scripts/generate_binary_build_matrix.py and regenerates the workflows. Triggered by mentions of "pin docker image", "update docker pin", "docker image pin", "pin builder images", or "bump the manywheel image pin" for a release branch.
---

# Release: Update Docker Image Pin

Pins the Linux manywheel builder docker images that the binary build workflows
in **pytorch/pytorch** use, so a release branch builds against a fixed,
reproducible toolchain instead of the floating tags that `main` tracks (e.g.
`pytorch/manylinux2_28-builder:cuda12.6`). The pin lives in the workflow
generator, so it survives `regenerate.sh` and the lint "generated files are up
to date" check.

This skill operates on a **pytorch/pytorch** checkout (usually a `release/X.Y`
branch), even though the skill itself lives in test-infra.

## Inputs

| Input | Required | Example | Notes |
|-------|----------|---------|-------|
| **Release version** | yes | `2.13` | The `release/X.Y` being pinned. Drives `RELEASE_VERSION_TAG` when regenerating and is used to sanity-check the checkout. |
| **pytorch/pytorch path** | only if ambiguous | `~/pytorch` | A checkout with the matching `release/X.Y` branch checked out. |

The **release version is the primary argument**. If it was not supplied when the
skill was invoked, ask for it before making any changes -- do not guess. Confirm
it matches the checkout with `cut -d'.' -f1-2 version.txt`.

## When to use this skill

Use when the user asks to:
- Pin / re-pin the manywheel (builder) docker images for a release
- Update or bump `DOCKER_IMAGE_PIN`
- Freeze the docker image the nightly/release binaries build with
- Refresh the docker image pin after the release branch's `.ci/docker` changed

## Background: how the pin maps to a published image

When the builder images are built (`.github/workflows/build-manywheel-images.yml`
and `build-manywheel-images-s390x.yml` via the `binary-docker-build` action),
each image is pushed with several tags, including:

```
docker.io/pytorch/<image>:<prefix>-${CI_FOLDER_SHA}
```

where `CI_FOLDER_SHA="$(git rev-parse HEAD:.ci/docker)"` -- the git tree hash of
the `.ci/docker` directory. This is exactly the value
`test-infra/.github/actions/calculate-docker-image` computes at runtime. Pinning
simply freezes that hash as a literal so the release stops tracking floating
tags. Example published image:

```
pytorch/manylinux2_28_aarch64-builder:cpu-aarch64-<CI_FOLDER_SHA>
```

Only **linux** manywheel builds run inside these containers, so only the linux
images are pinned. Windows and macOS keep the plain tag prefix.

## Target

Repo: **pytorch/pytorch** (the release branch you are pinning).

| Path | Role |
|------|------|
| `.github/scripts/generate_binary_build_matrix.py` | Holds `DOCKER_IMAGE_PIN`; the only file you edit by hand |
| `.github/workflows/generated-linux-binary-manywheel-nightly.yml` | Regenerated output (x86) |
| `.github/workflows/generated-linux-aarch64-binary-manywheel-nightly.yml` | Regenerated output (aarch64) |
| `.github/workflows/generated-linux-s390x-binary-manywheel-nightly.yml` | Regenerated output (s390x) |

## Instructions

### Step 1: Resolve inputs

Resolve the **Release version** and **pytorch/pytorch path** from the Inputs
table above. If the release version was not provided, ask for it now. Confirm
the checkout is on the matching branch and the version agrees:

```bash
cut -d'.' -f1-2 version.txt   # must equal the release version, e.g. 2.13
git rev-parse --abbrev-ref HEAD   # should be release/<version>
```

### Step 2: Compute the pin hash

From the root of the pytorch/pytorch checkout, on the release branch:

```bash
git rev-parse HEAD:.ci/docker
```

This 40-char hash is the new `DOCKER_IMAGE_PIN`. It is the same value the
builder images are published under. Do NOT invent or hand-edit it.

If the user instead points at a specific published image tag (e.g. from a known
good nightly on https://hud.pytorch.org), use the suffix from that tag and
verify it equals the `git rev-parse` output above; they should match on a fresh
release cut.

### Step 3 (optional): Verify the image exists

If the user wants confirmation, check that the tag exists on Docker Hub (a human
can open the URL; automated egress may be restricted):

```
https://hub.docker.com/r/pytorch/manylinux2_28_aarch64-builder/tags?name=cpu-aarch64-<HASH>
```

### Step 4: Update or add `DOCKER_IMAGE_PIN`

Open `.github/scripts/generate_binary_build_matrix.py`.

**If the pin block already exists** (re-pinning), just replace the hash:

```python
DOCKER_IMAGE_PIN = "<NEW_40_CHAR_HASH>"
```

**If pinning for the first time on this release branch**, add the block right
after the `WHEEL_CONTAINER_IMAGES` dict, and route the wheel tag prefix through
the helper. Add:

```python
# RELEASE-ONLY: pin the manywheel builder images to a fixed build so the release
# uses a reproducible toolchain instead of main's floating tags. The suffix is
# the .ci/docker tree hash (`git rev-parse HEAD:.ci/docker`), i.e. the same tag
# .github/actions/binary-docker-build publishes. Only linux manywheel builds run
# inside these containers, so only those images are pinned.
DOCKER_IMAGE_PIN = "<NEW_40_CHAR_HASH>"
MANYWHEEL_OSES = ("linux", "linux-aarch64", "linux-s390x")


def wheel_container_image_tag_prefix(arch_version: str, os: str) -> str:
    tag_prefix = WHEEL_CONTAINER_IMAGES[arch_version].split(":")[1]
    if os in MANYWHEEL_OSES:
        return f"{tag_prefix}-{DOCKER_IMAGE_PIN}"
    return tag_prefix
```

Then replace BOTH occurrences of the inline tag-prefix computation in
`generate_wheels_matrix` with a call to the helper:

```python
                        "container_image_tag_prefix": wheel_container_image_tag_prefix(
                            arch_version, os
                        ),
```

(The original reads `WHEEL_CONTAINER_IMAGES[arch_version].split(":")[1]`.)

### Step 5: Regenerate the workflows

Run the generator in release mode from the repo root:

```bash
RELEASE_VERSION_TAG=<RELEASE_VERSION> python3 .github/scripts/generate_ci_workflows.py
```

(Equivalent: `RELEASE_VERSION_TAG=<ver> ./.github/regenerate.sh`.)

### Step 6: Verify

```bash
# Only the three linux manywheel files should change:
git status --short .github/workflows/generated-*.yml

# Every linux builder image should carry the new hash; none floating:
grep -rhE "image: pytorch/manylinux" .github/workflows/generated-linux-*.yml | grep -v "<HASH>" || echo "none floating (good)"

# Windows/macOS must be unchanged (plain cpu / cuda12.6 prefixes):
grep -nE "docker_image_tag_prefix:" .github/workflows/generated-macos-arm64-binary-wheel-nightly.yml | grep -v '\${{'
```

Then confirm idempotency -- regenerating a second time must produce
byte-identical output (this is what the lint up-to-date check enforces):

```bash
md5sum .github/workflows/generated-linux-*.yml > /tmp/a
RELEASE_VERSION_TAG=<ver> python3 .github/scripts/generate_ci_workflows.py
md5sum .github/workflows/generated-linux-*.yml > /tmp/b
diff /tmp/a /tmp/b && echo "idempotent"
```

### Step 7: Lint and commit

Run `lintrunner -a` on the changed files, then commit. The commit message
should record the hash and that it equals `git rev-parse HEAD:.ci/docker`.
This is a release-only change; do not port it to `main`.

## Common pitfalls

- **Wrong hash**: always derive it with `git rev-parse HEAD:.ci/docker` on the
  release branch. A hand-typed or stale hash points at a nonexistent tag and
  every linux binary build will fail to pull its container.
- **Pinning windows/macOS**: those builds do not run in these containers. Keep
  the pin scoped to `MANYWHEEL_OSES`; a pinned windows/macOS prefix is wrong.
- **Editing the generated YAML directly**: the lint check regenerates and
  asserts no diff, so hand edits get reverted. Always change the generator.
- **Forgetting `RELEASE_VERSION_TAG`**: without it the regenerated reusable
  workflow refs/version may differ from the committed release files.

## Example usage

```
Pin the manywheel docker images for release/2.13
```

```
Re-pin the builder images, .ci/docker changed on the release branch
```
