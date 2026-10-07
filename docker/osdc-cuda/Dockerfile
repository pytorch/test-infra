# A stock CUDA image with the handful of things an OSDC job container needs.
#
# On OSDC the checkout and every step run *inside* this image, which the EC2
# runners never did -- there the host supplied git and the tar work happened
# host-side. nvidia/cuda ships none of it, so a job that only needed a label
# change otherwise fails in ways that look like test failures.
#
# See docs/osdc_runners.md "Constraints and gotchas" for the full list.

# Defaulted so a local `docker build` works without --build-arg; CI always
# passes one from the matrix.
ARG BASE_IMAGE=nvidia/cuda:13.0.2-cudnn-devel-ubuntu24.04
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        # actions/checkout wants git >= 2.18 on PATH inside the container.
        # Without it the checkout silently degrades to a REST API tarball with
        # no .git, and anything calling `git rev-parse` dies later on.
        git \
        # linux_job_v3 looks for a python to run run_with_env_secrets.py and
        # otherwise downloads a uv-managed interpreter on every single job.
        python3 \
        python3-pip \
        # git over https, and the usual fetch tools scripts reach for.
        ca-certificates \
        curl \
        # The k8s hook streams the workspace in as a tar and extracts it here,
        # then hash-verifies the result. Both are in the Ubuntu base already;
        # named so a base change that drops them fails this build, not a job.
        tar \
        findutils \
    && rm -rf /var/lib/apt/lists/*

# Deliberately NOT installed: the docker CLI. run_with_env_secrets.py branches
# on `shutil.which("docker")`, so a docker binary with no daemon -- which is
# every OSDC pod -- makes linux_job_v3 try to nest a container and fail.
RUN set -eux; \
    git --version; \
    python3 --version; \
    tar --version | head -1; \
    find --version | head -1; \
    ! command -v docker
