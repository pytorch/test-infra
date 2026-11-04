# [v.{VERSION}] Release Day Checklist

Tracking issue for the {VERSION} go-live. Legend: **auto** (workflow does it) · **gate** (validation must pass) · **manual** (human acts). Record the workflow-run URL next to each item as it completes.

## Build & validate final RC
- [ ] Build and test RC — *auto* (push `v{VERSION}-rc{N}` tag)
- [ ] Metadata validation of final RC (Python / CUDA / ROCm / OS matrix) — *gate*
- [ ] Run smoke tests for RC — *auto* (`validate-binaries.yml`, channel=test)
- [ ] Build & release Triton to PyPI + release notes — *manual* (OpenAI request)
- [ ] Validate wheels — *gate* (`validate-binaries.yml`)

## PyPI staging → production
- [ ] Stage wheels to PyPI (core + domains; linux/windows/mac) — *auto* (`release-stage-pypi.yml`)
- [ ] Inspect staged PyPI wheels (size / metadata / tag coverage) — *gate*
- [ ] Promote wheels to PyPI production (core + domains) — *manual→auto* (`release-pypi.yml`) ⚠️ one-shot
- [ ] Recompute prod checksums for torch — *auto* (`release-post-promotion.yml`)
- [ ] Validate PyPI packages: core, vision, audio — *gate* (`validate-binaries.yml`, channel=release)

## Docker
- [ ] Validate docker builds — *gate* (`validate-docker-images.yml`)
- [ ] Rebuild, test & upload docker to Docker Hub — *auto* (`release-docker.yml`)
- [ ] Validate `create_release.yml` succeeded — *gate*

## Website, install matrix & docs
- [ ] Update install commands / installation matrix — *auto (PR)* (`pytorch.github.io`)
- [ ] Update WordPress with install commands — *manual*
- [ ] Update previous-versions page — *manual (PR)*
- [ ] Push doc builds — *auto (core) / manual (libraries)*
- [ ] Docs redirects + remove prior release from search indexing + add prior release to previous versions — *manual (PR)*
- [ ] Push tutorials — *manual*
- [ ] Update compatibility matrix (core/vision/audio) — *manual (PR)* — **minor releases only**

## Tags, release notes & announcements
- [ ] Push final tag to core — *manual*
- [ ] Push final tag to vision (+ other domains) — *manual*
- [ ] Publish PyTorch release notes — *manual*
- [ ] Publish domain release notes — *manual*
- [ ] Open Colab version-update issue — *manual→scriptable*
- [ ] Publish blog post(s), feature on website, share on social — *manual*
- [ ] Announce on Dev Discuss and Slack; share with reporters — *manual*
