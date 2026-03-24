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
RUN dnf install -y \
        gcc-toolset-11-gcc \
        gcc-toolset-11-gcc-c++ \
        gcc-toolset-11-gcc-gfortran \
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

# Register clang runtime library directories so the linker can find libclang_rt.asan.so
# etc. without needing LD_LIBRARY_PATH hacks at CI time.
RUN for CLANG_VERSION in 15 18; do \
        INSTALL_DIR="/opt/clang-${CLANG_VERSION}" && \
        CLANG_RT_DIR=$("${INSTALL_DIR}/bin/clang" --print-runtime-dir 2>/dev/null || true) && \
        if [ -n "${CLANG_RT_DIR}" ] && [ -d "${CLANG_RT_DIR}" ]; then \
            echo "${CLANG_RT_DIR}" > "/etc/ld.so.conf.d/clang-${CLANG_VERSION}.conf"; \
        fi; \
    done && ldconfig

# Install uv (Python package manager) — needed before CUDA install for uv run
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# Install CUDA stack (skipped when INSTALL_CUDA is empty)
RUN --mount=type=bind,source=install_cuda.py,target=/tmp/install_cuda.py \
    if [ -n "${INSTALL_CUDA}" ]; then \
        uv run /tmp/install_cuda.py; \
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
