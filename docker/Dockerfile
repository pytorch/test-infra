# syntax=docker/dockerfile:1
ARG BASE_IMAGE=quay.io/pypa/manylinux_2_34_x86_64
FROM ${BASE_IMAGE}

# INSTALL_CUDA: set to any non-empty value (e.g. "1") to install all CUDA versions;
# leave empty for CPU-only images.
ARG INSTALL_CUDA
ARG NCCL_VERSION=v2.29.3-1
ARG NVSHMEM_VERSION=3.4.5

# System dependencies (adapted from PyTorch CI install_centos)
RUN dnf install -y \
        autoconf \
        automake \
        bzip2 \
        curl \
        clang \
        gcc \
        gcc-c++ \
        gdb \
        git \
        make \
        sudo \
        unzip \
        vim \
        wget \
        zip \
    && dnf clean all \
    && rm -rf /var/cache/dnf

# Install uv (Python package manager) — needed before CUDA install for uv run
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# Install CUDA stack (skipped when INSTALL_CUDA is empty)
RUN --mount=type=bind,source=install_cuda.py,target=/tmp/install_cuda.py \
    if [ -n "${INSTALL_CUDA}" ]; then \
        uv run /tmp/install_cuda.py \
            --nccl-version "${NCCL_VERSION}" \
            --nvshmem-version "${NVSHMEM_VERSION}"; \
    fi

# Install sccache (do this last so /opt/cache/bin gets PATH priority)
RUN --mount=type=bind,source=install_cache.py,target=/tmp/install_cache.py \
    uv run /tmp/install_cache.py
ENV PATH="/opt/cache/bin:${PATH}"

# CUDA environment (no-ops when CPU-only since the paths simply won't exist)
ENV PATH="/usr/local/cuda/bin:${PATH}"
ENV LD_LIBRARY_PATH="/usr/local/cuda/lib64:${LD_LIBRARY_PATH}"
ENV CUDA_HOME="/usr/local/cuda"
ENV USE_SYSTEM_NCCL=1
ENV NCCL_INCLUDE_DIR="/usr/local/cuda/include"
ENV NCCL_LIB_DIR="/usr/local/cuda/lib64"
