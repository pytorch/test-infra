# upload-docs

This is a reusable action to upload already built docs to a branch.

Assuming you follow convention for releases (ex release is tagged `v1.2.3`), this
will also make a folder for release tags.

Requirements:
* Main branch of the repository is called `main`
* Docs must be built prior to this job and the artifact must be uploaded to
* github, ideally using a actions/upload-artifact step at the end of
your build.  Within the artifact, you should have a docs folder containing the
files you want to upload to the branch

Inputs:
* `docs-branch`: The branch you want the docs to be uploaded to.  This is usually gh-pages
* `docs-name`: Name of the artifact uploaded to github.  If using
actions/upload-artifact, this should be the same as the `name` input on that
step
* `docs-path`: Path fo the artifact uploaded to github.  If using
actions/upload-artifact, this should be the same as the `path` input on that
step

Example use:

```
name: Build Docs

# These are the typical workflow triggering conditions used for most docs builds
on:
  push:
    branches:
      - main
      - release/*
    tags:
      - v[0-9]+.[0-9]+.[0-9]
      - v[0-9]+.[0-9]+.[0-9]+-rc[0-9]+
  pull_request:
  workflow_dispatch:

concurrency:
  group: build-docs-${{ github.workflow }}-${{ github.ref == 'refs/heads/main' && github.run_number || github.ref }}
  cancel-in-progress: true

defaults:
  run:
    shell: bash -l -eo pipefail {0}

jobs:
  build_docs:
    ... fill in params as desired
    steps:
      ... assorted steps to build the docs
      - uses: actions/upload-artifact@v3
        with:
          name: docs-name
          path: docs-path

  upload:
    needs: build_docs
    uses: pytorch/test-infra/.github/actions/upload-docs/action.yml@main
    with:
      docs-branch: gh-pages
      docs-name: docs-name
      docs-path: docs-path
```
