# docker-build-remote-buildkit

Build and push a Docker image from an OSDC/ARC runner.

OSDC runners are ephemeral Kubernetes pods with **no host docker daemon**, so `docker build` and
`docker/build-push-action`'s default driver do not work. OSDC instead runs a per-arch `buildkitd`
service in every cluster. This action registers it as a remote `buildx` builder and runs the build
against it.

```yaml
- uses: pytorch/test-infra/.github/actions/docker-build-remote-buildkit@main
  with:
    context: ./docker
    file: ./docker/Dockerfile
    tags: ghcr.io/pytorch/my-image:${{ github.sha }}
    build-args: |
      BASE_IMAGE=quay.io/pypa/manylinux_2_28_x86_64
```

The step blocks until the image has been pushed, so a job that builds an image and a job that
consumes it can be ordered with a plain `needs:` — no polling for the tag to appear.

## Why not `docker/setup-buildx-action`

Both `docker/setup-buildx-action` and `docker buildx create --bootstrap` run
`buildx inspect --bootstrap`, whose ~20s gRPC connect timeout expires on a cold or bursting builder
pool before the autoscaler can add a builder. This action uses a bare `docker buildx create` and
retries only *connection-phase* failures (`waiting for connection`, `failed to dial/list workers`,
`context deadline exceeded`, `server preface`, …). Once BuildKit has started the build, a failure is
a real build error and is never retried.

Each builder pod serves one build at a time (HAProxy `maxconn 1`), which is why the retry loop
matters during a burst; tune it with `connect-attempts` / `connect-delay`.

## Notes

- **Push, don't load.** There is no local daemon, so `--load` has nothing to load into. `push: false`
  builds and discards the image.
- **Remote BuildKit is per-arch.** `platforms` defaults to the runner's own architecture; to build
  for another platform you need a runner (and builder) of that architecture.
- BuildKit allows roughly 120 minutes per build — keep the job's `timeout-minutes` above that for
  large images.

Adapted from `pytorch/pytorch:.github/scripts/build_with_remote_buildkit.sh`.
