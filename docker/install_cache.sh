#!/bin/bash
# Install sccache from prebuilt GitHub release binaries.
# Adapted from PyTorch CI: .ci/docker/common/install_cache.sh
set -ex

SCCACHE_VERSION="${SCCACHE_VERSION:-v0.13.0}"

# Detect architecture
targetarch=${TARGETARCH:-$(uname -m)}
case "${targetarch}" in
  amd64|x86_64) arch="x86_64" ;;
  arm64|aarch64) arch="aarch64" ;;
  *) echo "Unsupported architecture: ${targetarch}"; exit 1 ;;
esac

# Download and install prebuilt sccache
tarball="sccache-${SCCACHE_VERSION}-${arch}-unknown-linux-musl.tar.gz"
url="https://github.com/mozilla/sccache/releases/download/${SCCACHE_VERSION}/${tarball}"

mkdir -p /opt/cache/bin
curl -fsSL "${url}" | tar xz --strip-components=1 -C /opt/cache/bin
chmod +x /opt/cache/bin/sccache

echo "sccache ${SCCACHE_VERSION} (${arch}) installed to /opt/cache/bin"
