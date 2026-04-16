# syntax=docker/dockerfile:1
ARG BASE_IMAGE=quay.io/pypa/manylinux_2_28_x86_64
FROM ${BASE_IMAGE}

# INSTALL_CUDA: set to any non-empty value (e.g. "1") to install all CUDA versions;
# leave empty for CPU-only images.
ARG INSTALL_CUDA

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
        jq \
        libomp-devel \
        make \
        sudo \
        unzip \
        vim \
        wget \
        zip \
    && dnf group install -y 'Development Tools' \
    && dnf clean all \
    && rm -rf /var/cache/dnf

# Install GCC toolset versions needed by CI.
# The manylinux_2_28 base image (AlmaLinux 8) ships with GCC 8 as the system
# default and bundles gcc-toolset-12 under /usr/local/bin. Install the
# additional toolset versions that PyTorch CI requires.
#
# gcc-toolset-11: Pre-built from source (GCC 11.4.0) because the RPM only
# provides 11.2.1, but PyTorch requires >= 11.3. The artifact is built by the
# build-gcc.yml workflow and uploaded to S3. It installs into
# /opt/rh/gcc-toolset-11/ with a compatible enable script.
# Also register its libstdc++.so.6 with ldconfig — the system /lib64/libstdc++.so.6
# is from GCC 8 and too old (missing GLIBCXX_3.4.26+). Clang uses libstdc++ at
# runtime, so binaries built with clang need a newer one visible to the linker.
RUN ARCH=$(uname -m) && PLATFORM="linux-${ARCH}" && \
    S3_URL="https://gha-artifacts.s3.amazonaws.com/gcc/${PLATFORM}/gcc-toolset-11/gcc-toolset-11-${PLATFORM}.tar.gz" && \
    echo "Installing gcc-toolset-11 from ${S3_URL}" && \
    curl -fsSL "${S3_URL}" -o /tmp/gcc-toolset-11.tar.gz && \
    mkdir -p /opt/rh/gcc-toolset-11 && \
    tar xzf /tmp/gcc-toolset-11.tar.gz -C /opt/rh/gcc-toolset-11 && \
    rm -f /tmp/gcc-toolset-11.tar.gz && \
    echo "/opt/rh/gcc-toolset-11/root/usr/lib64" > /etc/ld.so.conf.d/gcc-toolset-11.conf && \
    ldconfig

RUN dnf install -y \
        gcc-toolset-13-gcc \
        gcc-toolset-13-gcc-c++ \
        gcc-toolset-13-gcc-gfortran \
        gcc-toolset-14-gcc \
        gcc-toolset-14-gcc-c++ \
        gcc-toolset-14-gcc-gfortran \
    && dnf clean all \
    && rm -rf /var/cache/dnf

# Install pre-built clang 15 and 18 (clang 20 is already the system default)
RUN ARCH=$(uname -m) && PLATFORM="linux-${ARCH}" && \
    for CLANG_VERSION in 15 18; do \
        S3_URL="https://gha-artifacts.s3.amazonaws.com/clang/${PLATFORM}/clang-${CLANG_VERSION}/clang-${CLANG_VERSION}-${PLATFORM}.tar.gz" && \
        INSTALL_DIR="/opt/clang-${CLANG_VERSION}" && \
        echo "Installing clang ${CLANG_VERSION} from ${S3_URL}" && \
        curl -fsSL "${S3_URL}" -o /tmp/clang.tar.gz && \
        mkdir -p "${INSTALL_DIR}" && \
        tar xzf /tmp/clang.tar.gz -C "${INSTALL_DIR}" --strip-components=1 && \
        rm -f /tmp/clang.tar.gz; \
    done

# Register only clang-15 runtime library directory with ldconfig so the linker
# can find libclang_rt.asan.so for ASAN builds. Until we upgrade to RHEL 9, we
# can only use clang-15 for ASAN
RUN CLANG_RT_DIR=$("/opt/clang-15/bin/clang" --print-runtime-dir 2>/dev/null || true) && \
    if [ -n "${CLANG_RT_DIR}" ] && [ -d "${CLANG_RT_DIR}" ]; then \
        echo "${CLANG_RT_DIR}" > /etc/ld.so.conf.d/clang-15.conf; \
    fi && \
    ldconfig

# Install uv (Python package manager) — needed before CUDA install for uv run
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# Install CUDA stack (skipped when INSTALL_CUDA is empty)
RUN --mount=type=bind,source=install_cuda.py,target=/tmp/install_cuda.py \
    if [ -n "${INSTALL_CUDA}" ]; then \
        uv run /tmp/install_cuda.py; \
    fi

# Patch libstdc++ for CXX11 ABI symbol workaround
# See: https://github.com/pytorch/pytorch/issues/133437
RUN --mount=type=bind,source=patch_libstdc.sh,target=/tmp/patch_libstdc.sh \
    bash /tmp/patch_libstdc.sh

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
