# nvidia/cuda plus what an OSDC job container needs: the checkout and every
# step run inside this image, which the EC2 runners never did.

ARG BASE_IMAGE=nvidia/cuda:13.0.2-cudnn-devel-ubuntu24.04
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        python3 \
        python3-pip \
        ca-certificates \
        curl \
        tar \
        findutils \
    && rm -rf /var/lib/apt/lists/*

# No docker CLI on purpose: run_with_env_secrets.py branches on
# `shutil.which("docker")`, so a binary with no daemon makes linux_job_v3 try
# to nest a container and fail.
RUN set -eux; git --version; python3 --version; ! command -v docker
