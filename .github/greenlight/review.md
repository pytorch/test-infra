# GreenLight review policy: pytorch/test-infra

This is pytorch/test-infra's repository policy, its `.github/greenlight/review.md`, read
with the general policy in `.claude/skills/greenlight-review/SKILL.md`. It defines the
terms the general policy leaves to each repository and adds pytorch/test-infra's hard
stops. Here the repository is pytorch/test-infra and its checkout is `./target`: where
the general policy says "the repository's own" or "outside the repository", read
test-infra's own and outside test-infra. The workspace root around `./target` is
pytorch/test-infra too, at the commit GreenLight runs from, not the pull request's head:
read the repository's source only under `./target`. Every pull request you see here
comes from a collaborator with push access to pytorch/test-infra.

## User-facing surface

Breaking the user-facing surface: removing, deprecating, or renaming something test-infra
offers to outside code, or changing its signature, a default, a limit, or its documented
behavior; or changing the shape of output something parses. test-infra offers outside
code:

- the reusable workflows (the files under `.github/workflows/` with a `workflow_call`
  trigger) and the composite actions under `.github/actions/`, which other repositories
  call as `pytorch/test-infra/.github/...@<ref>`: their inputs, outputs, secrets, and
  defaults, and what their steps do for the caller;
- the scripts those workflows and actions run, where the caller passes them input or reads
  their results, such as `tools/scripts/generate_binary_build_matrix.py`;
- the HUD (`torchci/`): its page URLs and their query parameters, its API routes
  (`torchci/pages/api/`, `torchci/app/api/`), and the named ClickHouse queries in
  `torchci/clickhouse_queries/`, whose names, parameters, and result columns outside tools
  use when they run a query by name through `torchci/pages/api/clickhouse/[queryName].ts`;
- the Terraform module `terraform-aws-github-runner/`, which other projects import: its
  input variables and their defaults, its outputs, and the behavior its README documents.

Parsed output is the build matrix JSON the matrix workflows output
(`generate_binary_build_matrix.yml`, from `tools/scripts/generate_binary_build_matrix.py`,
and `generate_docker_release_matrix.yml`), the failure classification Dr. CI's route
`torchci/pages/api/drci/drci.ts` returns, which pytorch/pytorch's merge tooling reads, and
the responses of the HUD's API routes.
Everything else is internal: changing it does not break the user-facing surface, though a
hard stop below may still name it. Internal are the Lambdas under `aws/lambda/`, the
implementation of `terraform-aws-github-runner/`, the HUD's components and its
`torchci/lib/` modules, and tools and scripts no reusable workflow or action runs.

## Merge-gating workflows

Merging into `main` requires no status check other than GreenLight's gate
(`.github/workflows/greenlight-gate.yml`). `lint.yml` runs on every pull request, and
`torchci-preview.yml` (`pull_request_target`) on every pull request's `labeled` and
`synchronize` events; every other workflow with a `pull_request` trigger runs only when the
change touches a path its `paths` filter lists. Humans merge on the results of all of them,
so every workflow with a `pull_request` or `pull_request_target` trigger gates the merge of
the pull requests it runs on, and so does every reusable workflow or action such a workflow
calls.

## Lint gate

No lint gate blocks the merge: `lint.yml` runs on every pull request, but merging into
`main` does not require it to pass. The clearance **Mechanical formatting is already
gated** under **What to inspect** does not hold for pytorch/test-infra.

## Test layout

Test code is, outside `torchci/pages/` and `torchci/app/` (below):

- files under a directory named `test`, `tests`, `__tests__`, or `__test__`, such as
  `torchci/test/`, `greenlight/tests/`, `tools/tests/`, `tools/torchci/tests/`,
  `aws/lambda/tests/`, and `aws/lambda/<dir>/tests/`;
- files named `test_*.py`, such as `.github/scripts/test_*.py` and
  `aws/lambda/<dir>/test_lambda_function.py`, or `*.test.ts`, `*.test.tsx`, or
  `*.test.js`, wherever they sit.

Under `torchci/`, the `tests` directories outside `torchci/test/`
(`torchci/app/api/tests/`, `torchci/lib/api/tests/`, `torchci/lib/tests/`,
`torchci/components/tests/`, `torchci/pages/tests/`) are the HUD's test-results pages and
API, not test code. Under `torchci/pages/` and `torchci/app/` no file is test code,
whatever its name or directory: Next.js routes every file there, or runs it as a module a
route imports, so it is HUD code. What decides which tests run or how
their results are reported is CI configuration, not test code: the triggers, `paths`
filters, and test steps of the workflows under `.github/workflows/`, `conftest.py` files,
`[tool.pytest.ini_options]` in a `pyproject.toml`, `jest.config.js` files, and
`torchci/test/setup.ts` and `torchci/test/reporter.js`, which `torchci/jest.config.js`
loads.

## Hard stops

These add to **Never trivial** in the general policy; each item names what the general
item of that name covers here. Files named here for one of the four items that stop on the
path alone stop on the path alone too.

- Security, authentication, secrets, tokens, permissions, trust boundaries, and release or
  publish plumbing:
  - Code that a merge into `main` deploys with credentials, with no further human step, is
    a trust boundary, and editing any file in it is a stop: torchci's server code
    (`torchci/pages/api/`, `torchci/app/api/`, `torchci/lib/`, the saved queries under
    `torchci/clickhouse_queries/` that server code reads at request time,
    `torchci/next.config.js`, `torchci/tsconfig.json`, `torchci/package.json`, and
    `torchci/yarn.lock`, and every file under `torchci/pages/` and `torchci/app/`, which
    Next.js renders or runs on the server too; test code as **Test layout** defines it
    excluded), which goes to
    production on every push to `main` and runs with the GitHub App key the bots act with
    and the HUD's database and cloud credentials; and each Lambda a workflow
    deploys on a push to `main`: `aws/lambda/clickhouse-replicator-dynamo/`,
    `aws/lambda/clickhouse-replicator-s3/`, `aws/lambda/gha-artifacts/`,
    `aws/lambda/gha-log-uploader/`, `aws/lambda/log-classifier/`,
    `aws/lambda/opensearch-gha-jobs/`, `aws/lambda/servicelab-ingestor/`,
    `aws/lambda/whl_metadata_upload_pep658/`, and any other `aws/lambda/<dir>/` a workflow
    under `.github/workflows/` deploys on a push to `main`; and the runner configuration
    the org's runner autoscalers read from `main`: `.github/scale-config.yml`,
    `.github/lf-scale-config.yml`, `.github/canary-scale-config.yml`,
    `.github/lf-canary-scale-config.yml`, `.github/arc-runner-config.yaml`, and
    `.github/arc-node-config.yaml`, which choose the machine images and instance types the
    org's jobs, secret-holding ones included, run on. The exemption for the
    repository's own source under **CI privilege and merge gating** does not apply to this
    code.
  - The workflows that publish released artifacts are the binary build and upload
    reusable workflows and actions other repositories publish their packages with
    (`build_wheels_linux.yml`, `build_wheels_macos.yml`, `build_wheels_windows.yml`,
    `_binary_upload.yml`, `_upload_docs.yml`, and the actions `setup-binary-builds`,
    `setup-binary-upload`, and `set-channel`); the `release-*.yml` workflows; the S3
    index and mirror workflows (`update-s3-html.yml`, `update-s3-dependencies.yml`,
    `sync-triton-wheels-to-test.yml`); the image push workflows (`_docker-build.yml`,
    `docker-build.yml`, `osdc-cuda-images.yml`); the Lambda release workflows
    (`lambda-release-tag-runners.yml`, `_lambda-do-release-runners.yml`,
    `update-crcr-terrafile.yml`); `blast-release.yml`; and the scripts under `release/`
    and `s3_management/`. Any other workflow that writes to PyPI, the S3 buckets behind
    download.pytorch.org, or a container registry is release plumbing too.
- CI privilege and merge gating: every file under `.github/actions/`, every workflow under
  `.github/workflows/` with a `workflow_call` trigger, and the scripts they run count as an
  action, reusable workflow, or script used by a job that holds secrets or an OIDC role:
  other repositories, pytorch/pytorch among them, call them at `@main` from such jobs, and
  those callers are not in your inputs. The exemption for the repository's own source does
  not apply to these scripts.
- Merge authorization: GreenLight's own files and what decides, from here, what lands in
  pytorch/pytorch, each with the modules it imports:
  - every workflow under `.github/workflows/` and every action under `.github/actions/`:
    any workflow, a new one included, can name the environment that holds GreenLight's
    GitHub App key and run with it;
  - GreenLight: `.github/greenlight/` (this policy, `.github/greenlight/review.md`,
    and test-infra's own GreenLight config, which decides whom GreenLight approves here),
    `greenlight/` (GreenLight itself), its general policy and hooks under `.claude/`
    (`.claude/skills/greenlight-review/` and `.claude/hooks/greenlight/`), the root
    `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and `.mcp.json`, which every review session
    loads from test-infra's workspace,
    `.github/workflows/greenlight-*.yml`, `.github/scripts/greenlight_*`,
    `.github/actions/setup-uv/` and `.github/actions/upload-claude-usage/` (GreenLight's
    review and record jobs run them), `.github/workflows/_lambda-do-release-runners.yml`
    and `.github/workflows/lambda-release-tag-runners.yml` (they build GreenLight's scan
    Lambda),
    `torchci/pages/api/greenlight/` and `torchci/lib/greenlight/` (the ledger route
    pytorch/pytorch's land guard reads), `torchci/lib/clickhouse.ts`,
    `torchci/next.config.js`, `torchci/tsconfig.json` (its path aliases decide which module
    an import resolves to), `aws/lambda/clickhouse-replicator-s3/` (it writes the
    ledger's rows), `tools/torchci/greenlight_replay/`,
    `tools/torchci/greenlight_decisions/`, the root `pyproject.toml`, `uv.toml`, and
    `uv.lock`, the root mise configuration (`mise.toml`, `.mise.toml`, `mise.local.toml`,
    `.mise.local.toml`, `.tool-versions`, `.config/`, `.mise/`, `mise/`, `.rtx.toml`,
    `.rtx.local.toml`), which GreenLight's jobs load when
    they run `mise` in `greenlight/`, and `torchci/package.json` and `torchci/yarn.lock`
    (they decide the code the ledger route runs);
  - Dr. CI's failure classification, which pytorch/pytorch's merge tooling reads to decide
    which failures block a merge: `torchci/pages/api/drci/drci.ts`, with the saved queries
    under `torchci/clickhouse_queries/` it and its modules run;
  - pytorchbot's merge command handling: `torchci/lib/bot/pytorchBotHandler.ts`;
  - who may act through the HUD: `torchci/lib/auth/`, `torchci/lib/api/auth.ts`,
    `torchci/pages/api/auth/`, and `torchci/lib/github.ts` (the GitHub clients the auth
    check reads the caller's identity through).
- Code ownership: `CODEOWNERS` at the root, in `.github/`, or in `docs/`. GitHub reads the
  first of `.github/CODEOWNERS`, `CODEOWNERS`, and `docs/CODEOWNERS` that exists, so a
  file added in `.github/` replaces every rule of the root file.
