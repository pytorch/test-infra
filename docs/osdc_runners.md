# Using OSDC runners — a guide to writing CI jobs

OSDC runners are PyTorch's Kubernetes-hosted self-hosted GitHub Actions runners, run with ARC (Actions
Runner Controller) and operated from [`pytorch/ci-infra`](https://github.com/pytorch/ci-infra). This
guide covers how to target them from a workflow: picking a runner, writing the job, building images, and
the constraints to design around.

## Mental model

An OSDC runner is an **ephemeral Kubernetes pod** on a cluster node. Targeting one is two decisions:

1. **Hardware**, chosen by the runner *label* (`mt-l-x86…`). The label is the only thing that decides
   vCPU, RAM, GPU and disk.
2. **Software**, which comes entirely from **a container image you provide**. The runner pod ships only
   the actions-runner agent: no preinstalled toolchain, no system python, cuda, compilers or git-lfs, and
   **no host docker daemon**. Whatever your job needs must be in the image you name, and to *build* an
   image you use the remote BuildKit service described in §5, not `docker build`.

Everything else below follows from those two facts.

---

## 1. Quick start with `linux_job_v3`

For most jobs, call the reusable
[`linux_job_v3.yml`](https://github.com/pytorch/test-infra/blob/main/.github/workflows/linux_job_v3.yml)
rather than writing the pod plumbing yourself. It handles checkout, the container, AWS credentials and
artifact upload. You supply a **runner label**, a **container image** and a **script**:

```yaml
jobs:
  my-build:
    uses: pytorch/test-infra/.github/workflows/linux_job_v3.yml@main
    with:
      runner: mt-l-x86iavx512-8-64                 # OSDC label → 8 vCPU / 64 GiB
      docker-image: ghcr.io/pytorch/my-ci-image:latest   # prebuilt, pullable image
      timeout: 60
      submodules: recursive
      script: |
        python -m pip install -e .
        pytest test/
```

For a GPU job, set `gpu-arch-type: cuda` and pick a GPU label. The container then gets `--gpus all`
automatically:

```yaml
  my-gpu-test:
    uses: pytorch/test-infra/.github/workflows/linux_job_v3.yml@main
    with:
      runner: mt-l-x86aavx2-29-113-a10g            # 1× A10G
      gpu-arch-type: cuda
      gpu-arch-version: "12.4"
      docker-image: ghcr.io/pytorch/my-cuda-image:latest
      script: pytest test/ -m gpu
```

Common inputs: `runner`, `docker-image`, `gpu-arch-type`/`gpu-arch-version`, `script`, `timeout`,
`repository`, `ref`, `submodules`, `download-artifact`, `upload-artifact`, `upload-artifact-to-s3`,
`secrets-env`. If you omit `docker-image` it defaults to `pytorch/almalinux-builder:<arch>`.

## 2. Standalone pattern

If your job doesn't fit the single-container shape of `linux_job_v3`, write it directly against a raw ARC
label plus a `container:` block:

```yaml
jobs:
  build:
    runs-on: mt-l-x86iavx512-16-128                # OSDC label
    container:
      image: ghcr.io/pytorch/my-ci-image:latest    # your image = your toolchain
      options: --gpus all                          # only for GPU labels
    permissions:
      id-token: write                              # required to assume role/arc
      contents: read
    steps:
      - uses: actions/checkout@v4
        with: { submodules: recursive }
      - run: python -m pip install -e . && pytest test/
```

Rules for the standalone pattern:

- **No host docker.** You cannot run `docker build` or `docker pull` on the node. Put everything in
  `container.image` and build new images with BuildKit, as described in §5. This is the most common
  breakage when porting a job from EC2.
- **Avoid `sudo` and job-time package installs.** Bake everything the job needs into the image rather
  than running `yum install` or `apt-get install` from a step. `sudo` may not even be present in your
  image.
- **No relative action paths.** `uses: ./.github/actions/foo` does not resolve; see §6 #6. Reference
  actions by their full `owner/repo/.github/actions/<name>@ref` path instead.
- **AWS access goes through `role/arc`.** The pod carries no credentials of its own, so assume the role
  via GitHub OIDC as shown in §4 rather than reusing an EC2 host role.

## 3. Picking a runner label

### How to read a label

Labels you write in a workflow look like this:

`mt-l-[b]{arch}{vendor}{features}-{vcpu}-{memory}[-{gpu}[-{count}]]`

- `mt-l-` is the prefix for production Linux runners. **Use it for every job.**
- `arch` is `x86` or `arm64`. `vendor` is `i` for Intel-ISA, `a` for AMD-ISA, `g2`/`g3`/`g4` for Graviton
  generation. `features` is `avx2`, `avx512` or `amx`.
- `{vcpu}-{memory}` is vCPU count and **GiB**. A GPU suffix is `t4`, `a10g`, `l4`, `a100` or `h100`, plus
  a count when there is more than one.
- A `b` before the architecture means bare metal, so the job gets a whole node to itself.

For example, `mt-l-x86aavx2-29-113-a10g` is a Linux x86 AMD-ISA AVX2 runner with 29 vCPU, 113 GiB and one
A10G. The full grammar, including prefixes used by other fleets, is in
[`runner_naming_convention.md`](https://github.com/pytorch/ci-infra/blob/main/osdc/docs/runner_naming_convention.md).

### Where the labels come from

| Question | Where to look |
|---|---|
| Which labels exist, and what hardware does each one give me? | [`osdc/modules/arc-runners/defs/`](https://github.com/pytorch/ci-infra/tree/main/osdc/modules/arc-runners/defs), one YAML file per label listing its vCPU, memory, disk and GPU |
| Which OSDC label replaces the EC2 label my job uses today? | [`pytorch/pytorch:.github/arc.yaml`](https://github.com/pytorch/pytorch/blob/main/.github/arc.yaml), under `runner_mapping` |

Common mappings, with the full list in `arc.yaml`:

| EC2 label | OSDC label | Hardware |
|---|---|---|
| `linux.2xlarge` | `mt-l-x86iavx512-8-64` | 8 vCPU / 64Gi / 200G |
| `linux.4xlarge` | `mt-l-x86iavx512-16-128` | 15 vCPU / 116Gi / 300G |
| `linux.12xlarge` | `mt-l-x86iavx512-48-384` | 46 vCPU / 350Gi / 600G |
| `linux.arm64.m7g.4xlarge` | `mt-l-arm64g3-16-62` | 15 vCPU / 56Gi / 256G |
| `linux.g5.4xlarge.nvidia.gpu` | `mt-l-x86aavx2-29-113-a10g` | 1× A10G, 29 vCPU / 113Gi |
| `linux.aws.h100` | `mt-l-x86iamx-22-225-h100` | 1× H100, 22 vCPU / 225Gi |

### Special cases

- **`-fab` H100 variants.** Every H100 label has a `-fab` counterpart with IMEX channels configured for
  multi-node GPU fabric. Use the plain label unless your job specifically needs IMEX.
- **`rel-` release pool.** `rel-l-x86iavx512-44-340` and `rel-l-arm64g3-44-340` are reserved for building
  release artifacts such as wheels, and live in a protected runner group rather than the general pool.
  Don't point an ordinary job at them; contact the Dev Infra team if you need access.
- **Non-OSDC runners are unchanged.** Labels with no OSDC equivalent, such as ROCm, XPU and TPU, map to
  themselves in `arc.yaml`, so those jobs keep running exactly where they do today.

## 4. Fork PRs and OIDC

OSDC jobs get AWS access by assuming `arn:aws:iam::308535385114:role/arc` through GitHub OIDC, which
requires a **writable OIDC token**. Give the job the permission and assume the role:

```yaml
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::308535385114:role/arc
          aws-region: us-east-1
          role-duration-seconds: 18000             # the server-side maximum
```

`linux_job_v3` does this for you. GitHub treats fork PRs differently, and that changes what a job can do:

| | Same-repo PR or push | Fork PR |
|---|---|---|
| `id-token: write` (OIDC token) | granted | **withheld**, no token can be minted |
| Repo secrets | available | **not exposed** |
| Can assume `role/arc` | yes | **no**, `configure-aws-credentials` fails |

For that reason
[`linux_job_v3`](https://github.com/pytorch/test-infra/blob/main/.github/workflows/linux_job_v3.yml)
marks its "Configure AWS credentials" step **`continue-on-error: true`**: on a fork PR the assume-role
step fails and the job continues *without* AWS credentials. The practical consequences:

- **Uploading artifacts or docs to S3 does not work on fork PRs**, which covers `upload-artifact-to-s3`
  and doc-preview upload. Use GitHub-native `upload-artifact` if the artifact must survive on a fork PR.
- **Any step that needs `role/arc`, a registry push or a secret will fail or be skipped on a fork PR.**
  Gate those steps on `github.event.pull_request.head.repo.fork == false`, or move image builds and
  pushes to a same-repo trigger such as `push` or a `workflow_run` after merge.
- If you need to run privileged work against fork-PR *content*, use a `pull_request_target` workflow with
  care. It runs with the base repository's token and secrets against fork code, which is easy to turn
  into a security hole, so restrict it to trusted steps that never execute fork code, such as labeling.

## 5. Building a Docker image with BuildKit

This section applies only if your job builds an image rather than pulling one.

There is no docker daemon on an OSDC runner, so `docker build` fails. OSDC instead runs a per-architecture
remote `buildkitd` in every cluster, reachable at `tcp://buildkitd-amd64.buildkit:1234` and
`tcp://buildkitd-arm64.buildkit:1234`. Drive it through test-infra's composite action, which registers the
builder for the runner's architecture and retries the connection failures a cold builder pool produces:

```yaml
      - name: Build & push
        uses: pytorch/test-infra/.github/actions/docker-build-remote-buildkit@main
        with:
          context: ./docker
          tags: ghcr.io/pytorch/my-ci-image:${{ github.sha }}
          push: true          # --push, never --load: there is no local daemon to load into
```

If your build is driven by a script or a make target rather than a direct `buildx` call, pass the whole
command instead of the buildx inputs. The command owns its own tags and `--push`:

```yaml
        with:
          command: .ci/docker/manywheel/build.sh manylinux2_28-builder:cpu
```

Do not use `docker/setup-buildx-action`, and do not pass `--bootstrap`: both run
`buildx inspect --bootstrap`, whose short connect timeout expires on a cold builder pool before the
autoscaler can add a builder. The action's
[README](https://github.com/pytorch/test-infra/tree/main/.github/actions/docker-build-remote-buildkit)
covers the remaining inputs.

### Make sure the image exists before you use it

**Never assume the image is there.** Check the registry first and build it only if it is missing, so the
job is correct whether or not something else already built it:

```yaml
      - name: Resolve the image, building it if it is missing
        id: image
        run: |
          set -euo pipefail
          # A content-addressed tag: "exists" then means exactly the right image,
          # which a mutable tag like :latest can never guarantee.
          TAG="ghcr.io/pytorch/my-ci-image:$(git rev-parse HEAD:docker)"
          echo "tag=${TAG}" >> "${GITHUB_OUTPUT}"
          # Registry-side inspect; no local daemon needed.
          if docker buildx imagetools inspect "${TAG}" >/dev/null 2>&1; then
            echo "exists=true" >> "${GITHUB_OUTPUT}"
          else
            echo "exists=false" >> "${GITHUB_OUTPUT}"
          fi

      - name: Build the image
        if: steps.image.outputs.exists == 'false'
        uses: pytorch/test-infra/.github/actions/docker-build-remote-buildkit@main
        with:
          context: ./docker
          tags: ${{ steps.image.outputs.tag }}
          push: true
```

The build step only returns once the push has completed, so anything after it can use
`steps.image.outputs.tag` safely. What not to do: start a job that pulls an image some other workflow is
still building, and retry the pull until it appears. That either fails on a missing manifest or silently
runs against a stale image, and it is why the check above resolves a content-addressed tag rather than a
floating one.

## 6. Constraints and gotchas

1. **You must supply a prebuilt, pullable image.** Build new images with BuildKit, as described in §5.
   There is no host `docker build`, and job-time package installs such as `sudo yum install` belong in
   the image instead.
2. **Size the label by what the job needs**, not by the name of the EC2 runner it used to run on. The
   EC2-to-ARC translation is not 1:1 on RAM. Check the runner defs linked in §3 and pick the RAM and GPU
   you need.
3. **Machine-wide CPU counts are misleading.** `std::thread::hardware_concurrency()`, `os.cpu_count()`
   and `multiprocessing.cpu_count()` report the node's CPUs, not the pod's cpuset, for example 192
   rather than 16. Pin thread counts explicitly, or use an affinity-aware call such as `nproc` or
   `len(os.sched_getaffinity(0))`.
4. **Linux only.** There is no Windows or macOS, and no ROCm, XPU or TPU on OSDC; those stay on their
   partner clouds.
5. **Fork PRs have no OIDC token and no secrets.** See §4.
6. **No relative action paths.** `uses: ./.github/actions/<name>` fails even with the repository checked
   out at the workspace root, because the ARC Kubernetes hook copies the workspace into the job
   container and the runner process itself never sees the checkout. The symptom is
   `Can't find 'action.yml'` *after* a successful checkout. Use
   `uses: <owner>/<repo>/.github/actions/<name>@<ref>` instead, which fetches the action from GitHub.
   The action then comes from `<ref>` rather than the PR's own checkout, so a PR that changes an action
   must point the ref at its own branch to test it.
7. **Path expressions return host paths, not container paths.** `${{ runner.temp }}` and
   `${{ github.workspace }}` evaluate to the runner's own filesystem (`/home/runner/_work/...`),
   while your job sees the container mount (`/__w/...`). Passing one of those expressions to a
   command running in the container gives "path not found" for a file you just created. Use the
   `$RUNNER_TEMP` and `$GITHUB_WORKSPACE` environment variables instead, or write the path to a step
   output and reference that.
8. **`container.image` cannot read `secrets` or `env`.** Only `github`, `needs`, `strategy`, `matrix`,
   `vars` and `inputs` are allowed there, so `image: ${{ inputs.docker-image }}` works but
   `image: ${{ secrets.X }}` fails at startup with "context not available". For a private image, put the
   credentials in `container.credentials`, which does allow `secrets`. Likewise `uses:` is always
   literal: you cannot template the action or its `@ref`.

---

## Appendix: sources

Where the information above comes from. These are primarily of interest to the Dev Infra team; link to
them rather than re-deriving their contents.

- Runner naming convention — [`osdc/docs/runner_naming_convention.md`](https://github.com/pytorch/ci-infra/blob/main/osdc/docs/runner_naming_convention.md)
- Deployed runner defs — [`osdc/modules/arc-runners/defs/`](https://github.com/pytorch/ci-infra/tree/main/osdc/modules/arc-runners/defs) and `arc-runners-h100`
- Which labels are live per cluster — [`osdc/clusters.yaml`](https://github.com/pytorch/ci-infra/blob/main/osdc/clusters.yaml)
- Runner image pinning — [`osdc/docs/runner-image-autoresolve.md`](https://github.com/pytorch/ci-infra/blob/main/osdc/docs/runner-image-autoresolve.md)
- BuildKit service — [`osdc/modules/buildkit/README.md`](https://github.com/pytorch/ci-infra/blob/main/osdc/modules/buildkit/README.md)
- Image build action — [`test-infra/.github/actions/docker-build-remote-buildkit`](https://github.com/pytorch/test-infra/tree/main/.github/actions/docker-build-remote-buildkit)
- EC2 to OSDC label mapping — [`pytorch/pytorch:.github/arc.yaml`](https://github.com/pytorch/pytorch/blob/main/.github/arc.yaml)
- Reusable workflow — [`test-infra/.github/workflows/linux_job_v3.yml`](https://github.com/pytorch/test-infra/blob/main/.github/workflows/linux_job_v3.yml)
