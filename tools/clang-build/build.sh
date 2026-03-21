#!/usr/bin/env bash
# Build clang, clang libraries, and libomp from LLVM source.
#
# Usage: ./build.sh <LLVM_VERSION> <INSTALL_PREFIX> [LLVM_TARGETS]
#
# Example:
#   ./build.sh 18.1.8 /opt/clang-18 "X86;AArch64"
#
# The script downloads the LLVM source, builds clang + openmp, and installs
# into the given prefix. The prefix will contain bin/, lib/, include/, etc.
set -euxo pipefail

LLVM_VERSION="${1:?Usage: build.sh <LLVM_VERSION> <INSTALL_PREFIX> [LLVM_TARGETS]}"
INSTALL_PREFIX="${2:?Usage: build.sh <LLVM_VERSION> <INSTALL_PREFIX> [LLVM_TARGETS]}"
LLVM_TARGETS="${3:-native}"

NPROC=$(nproc)
# Limit link parallelism to avoid OOM (LLVM linking is very memory-intensive)
LINK_JOBS=$(( NPROC > 4 ? 4 : NPROC ))

WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

echo "::group::Download LLVM ${LLVM_VERSION} source"
TARBALL="llvm-project-${LLVM_VERSION}.src.tar.xz"
DOWNLOAD_URL="https://github.com/llvm/llvm-project/releases/download/llvmorg-${LLVM_VERSION}/${TARBALL}"
wget -q -O "${WORKDIR}/${TARBALL}" "${DOWNLOAD_URL}"
echo "::endgroup::"

echo "::group::Extract source"
cd "${WORKDIR}"
tar xf "${TARBALL}"
# Handle both naming conventions (with and without .src suffix)
if [ -d "llvm-project-${LLVM_VERSION}.src" ]; then
    SRCDIR="${WORKDIR}/llvm-project-${LLVM_VERSION}.src"
elif [ -d "llvm-project-${LLVM_VERSION}" ]; then
    SRCDIR="${WORKDIR}/llvm-project-${LLVM_VERSION}"
else
    echo "ERROR: Could not find extracted source directory"
    ls -la "${WORKDIR}"
    exit 1
fi
echo "::endgroup::"

echo "::group::Configure build"
BUILD_DIR="${WORKDIR}/build"
mkdir -p "${BUILD_DIR}"
cd "${BUILD_DIR}"

CMAKE_ARGS=(
    -G Ninja
    -DCMAKE_BUILD_TYPE=Release
    -DCMAKE_INSTALL_PREFIX="${INSTALL_PREFIX}"
    -DLLVM_ENABLE_PROJECTS="clang"
    -DLLVM_ENABLE_RUNTIMES="openmp"
    -DLLVM_TARGETS_TO_BUILD="${LLVM_TARGETS}"
    -DLLVM_BUILD_UTILS=ON
    -DLLVM_INSTALL_UTILS=ON
    -DLLVM_ENABLE_TERMINFO=OFF
    -DLLVM_ENABLE_ZLIB=ON
    -DLLVM_INCLUDE_TESTS=OFF
    -DLLVM_INCLUDE_EXAMPLES=OFF
    -DLLVM_INCLUDE_BENCHMARKS=OFF
    -DLLVM_INCLUDE_DOCS=OFF
    -DLLVM_PARALLEL_LINK_JOBS="${LINK_JOBS}"
    -DCMAKE_C_COMPILER=gcc
    -DCMAKE_CXX_COMPILER=g++
)

cmake "${CMAKE_ARGS[@]}" "${SRCDIR}/llvm"
echo "::endgroup::"

echo "::group::Build (using ${NPROC} cores, ${LINK_JOBS} link jobs)"
ninja -j"${NPROC}"
echo "::endgroup::"

echo "::group::Install to ${INSTALL_PREFIX}"
mkdir -p "${INSTALL_PREFIX}"
ninja install
echo "::endgroup::"

echo "::group::Verify installation"
"${INSTALL_PREFIX}/bin/clang" --version
"${INSTALL_PREFIX}/bin/clang++" --version

# Verify libomp exists
if ls "${INSTALL_PREFIX}"/lib/libomp* 2>/dev/null; then
    echo "libomp: OK"
else
    echo "WARNING: libomp libraries not found in ${INSTALL_PREFIX}/lib/"
    # Check lib64 as well (some distros use lib64)
    if ls "${INSTALL_PREFIX}"/lib64/libomp* 2>/dev/null; then
        echo "libomp found in lib64/: OK"
    fi
fi

# Verify clang headers/libs exist
if [ -d "${INSTALL_PREFIX}/lib/clang" ]; then
    echo "clang resource dir: OK"
else
    echo "WARNING: clang resource dir not found"
fi
echo "::endgroup::"

echo "Build complete. Clang ${LLVM_VERSION} installed to ${INSTALL_PREFIX}"
