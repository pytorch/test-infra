#!/usr/bin/env bash
# Build numpy wheels for preview CPython versions (e.g. 3.15 / 3.15t) inside a
# manylinux builder image.  The resulting wheels are left in a wheelhouse for
# the workflow to upload to download.pytorch.org (S3 + R2).
#
# Why this exists:
#   numpy does not yet publish cp315 wheels on PyPI.  When torch preview-Python
#   wheels are built or smoke-tested, pip tries to resolve numpy and falls back
#   to building it from an sdist, which fails in the constrained build/test
#   environment.  Pre-building numpy here and hosting it on the pytorch index
#   lets those installs resolve a real wheel instead.
#
# This must run inside a pytorch manylinux builder image that ships the target
# interpreters under /opt/python (e.g. pytorch/manylinux2_28-builder:cpu).
#
# Required env:
#   ARCH               x86_64 | aarch64
# Optional env:
#   NUMPY_VERSION      numpy version to build            (default: 2.5.1)
#   PYTHON_VERSIONS    space separated                   (default: "3.15 3.15t")
#   MANYWHEEL_VERSION  manylinux platform tag version    (default: 2_28)

set -euo pipefail

NUMPY_VERSION="${NUMPY_VERSION:-2.5.1}"
PYTHON_VERSIONS="${PYTHON_VERSIONS:-3.15 3.15t}"
MANYWHEEL_VERSION="${MANYWHEEL_VERSION:-2_28}"
ARCH="${ARCH:?ARCH must be set (x86_64|aarch64)}"

PLAT="manylinux_${MANYWHEEL_VERSION}_${ARCH}"
BUILD_DIR="/tmp/numpy-preview-build"
WHEELHOUSE="${BUILD_DIR}/wheelhouse"

rm -rf "${BUILD_DIR}"
mkdir -p "${WHEELHOUSE}"

# 3.15 -> cp315 ; 3.15t -> cp315t
cp_tag() {
  local ver="$1" suffix=""
  if [[ "${ver}" == *t ]]; then
    suffix="t"
    ver="${ver%t}"
  fi
  echo "cp${ver//./}${suffix}"
}

# 3.15  -> /opt/python/cp315-cp315/bin/python
# 3.15t -> /opt/python/cp315-cp315t/bin/python
# Free-threaded builds only carry the 't' on the ABI tag, not the interpreter tag.
py_bin() {
  local ver="$1" suffix=""
  if [[ "${ver}" == *t ]]; then
    suffix="t"
    ver="${ver%t}"
  fi
  local digits="${ver//./}"
  echo "/opt/python/cp${digits}-cp${digits}${suffix}/bin/python"
}

echo "==> numpy==${NUMPY_VERSION}  arch=${ARCH}  plat=${PLAT}"
echo "==> python versions: ${PYTHON_VERSIONS}"

for pyver in ${PYTHON_VERSIONS}; do
  tag="$(cp_tag "${pyver}")"
  py="$(py_bin "${pyver}")"

  if [[ ! -x "${py}" ]]; then
    echo "::error::Interpreter for ${pyver} not found at ${py}"
    exit 1
  fi

  echo "==> Building numpy==${NUMPY_VERSION} for ${tag} (${py})"
  work="${BUILD_DIR}/${tag}"
  mkdir -p "${work}"

  "${py}" -m pip install --upgrade pip auditwheel

  # --no-binary forces a source build against this exact interpreter so the
  # produced extension modules target the preview CPython ABI.
  "${py}" -m pip wheel --no-deps --no-binary numpy \
    --wheel-dir "${work}" "numpy==${NUMPY_VERSION}"

  # numpy's source build emits a linux_<arch> tagged wheel that bundles OpenBLAS
  # but references libgfortran/libquadmath from the toolchain; auditwheel vendors
  # those in and rewrites the platform tag to a compliant manylinux tag.
  for whl in "${work}"/numpy-*.whl; do
    echo "    auditwheel repair ${whl##*/} -> ${PLAT}"
    "${py}" -m auditwheel repair \
      --plat "${PLAT}" \
      --wheel-dir "${WHEELHOUSE}" \
      "${whl}"
  done
done

echo "==> Built wheels:"
ls -la "${WHEELHOUSE}"

# Uploading to S3 (s3://pytorch) and R2 (s3://pytorch-downloads) is handled by
# the workflow, which manages the two distinct credential contexts.
