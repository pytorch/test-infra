# syntax=docker/dockerfile:1
ARG BASE_IMAGE=quay.io/pypa/manylinux_2_34_x86_64
FROM ${BASE_IMAGE}

# INSTALL_CUDA: set to any non-empty value (e.g. "1") to install all CUDA versions;
# leave empty for CPU-only images.
ARG INSTALL_CUDA
ARG NCCL_VERSION=v2.28.9-1
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

# Install CUDA stack (skipped when INSTALL_CUDA is empty)
RUN --mount=type=bind,source=install_cuda.sh,target=/tmp/install_cuda.sh \
    if [ -n "${INSTALL_CUDA}" ]; then \
        NCCL_VERSION="${NCCL_VERSION}" NVSHMEM_VERSION="${NVSHMEM_VERSION}" \
        bash /tmp/install_cuda.sh; \
    fi

# Install uv (Python package manager)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# Install sccache (do this last so /opt/cache/bin gets PATH priority)
RUN --mount=type=bind,source=install_cache.sh,target=/tmp/install_cache.sh \
    bash /tmp/install_cache.sh
ENV PATH="/opt/cache/bin:${PATH}"

# CUDA environment (no-ops when CPU-only since the paths simply won't exist)
ENV PATH="/usr/local/cuda/bin:${PATH}"
ENV LD_LIBRARY_PATH="/usr/local/cuda/lib64:${LD_LIBRARY_PATH}"
ENV CUDA_HOME="/usr/local/cuda"
ENV USE_SYSTEM_NCCL=1
ENV NCCL_INCLUDE_DIR="/usr/local/cuda/include"
ENV NCCL_LIB_DIR="/usr/local/cuda/lib64"
