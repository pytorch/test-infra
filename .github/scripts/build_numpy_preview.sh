#!/usr/bin/env bash
# Build numpy wheels for preview CPython versions (e.g. 3.15 / 3.15t) inside a
# manylinux builder image and upload them to download.pytorch.org.
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
#   CHANNELS           download.pytorch.org channels     (default: "nightly test")
#   MANYWHEEL_VERSION  manylinux platform tag version    (default: 2_28)
#   DRY_RUN            "true" builds but does not upload  (default: true)

set -euo pipefail

NUMPY_VERSION="${NUMPY_VERSION:-2.5.1}"
PYTHON_VERSIONS="${PYTHON_VERSIONS:-3.15 3.15t}"
CHANNELS="${CHANNELS:-nightly test}"
MANYWHEEL_VERSION="${MANYWHEEL_VERSION:-2_28}"
DRY_RUN="${DRY_RUN:-true}"
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

# cp315 -> /opt/python/cp315-cp315/bin/python
py_bin() {
  local tag
  tag="$(cp_tag "$1")"
  echo "/opt/python/${tag}-${tag}/bin/python"
}

echo "==> numpy==${NUMPY_VERSION}  arch=${ARCH}  plat=${PLAT}"
echo "==> python versions: ${PYTHON_VERSIONS}"
echo "==> channels: ${CHANNELS}   dry_run=${DRY_RUN}"

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

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "==> DRY RUN: skipping upload to download.pytorch.org"
  exit 0
fi

# Upload to s3://pytorch/whl/<channel>/ with the same public-read ACL and
# checksum metadata the binary upload workflow uses for torch wheels.
for channel in ${CHANNELS}; do
  dest="s3://pytorch/whl/${channel}/"
  echo "==> Uploading to ${dest}"
  for pkg in "${WHEELHOUSE}"/numpy-*.whl; do
    shm_id="$(sha256sum "${pkg}" | awk '{print $1}')"
    aws s3 cp "${pkg}" "${dest}" \
      --acl public-read \
      --metadata "checksum-sha256=${shm_id}"
  done
done

echo "==> Done. Run the 'Update S3 HTML indices' workflow (or wait for the"
echo "    hourly cron) to publish numpy in the whl/<channel> package indices."
