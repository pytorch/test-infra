#!/usr/bin/env bash
# Build GCC from source and install into a gcc-toolset-compatible prefix.
#
# Usage: ./build.sh <GCC_VERSION> <TOOLSET_NUMBER>
#
# Example:
#   ./build.sh 11.4.0 11
#
# This installs GCC into /opt/rh/gcc-toolset-<TOOLSET_NUMBER>/root/usr so that
# it is a drop-in replacement for the RPM-packaged gcc-toolset. Activate with:
#   source /opt/rh/gcc-toolset-<TOOLSET_NUMBER>/enable
set -euxo pipefail

GCC_VERSION="${1:?Usage: build.sh <GCC_VERSION> <TOOLSET_NUMBER>}"
TOOLSET="${2:?Usage: build.sh <GCC_VERSION> <TOOLSET_NUMBER>}"

TOOLSET_ROOT="/opt/rh/gcc-toolset-${TOOLSET}"
PREFIX="${TOOLSET_ROOT}/root/usr"

NPROC=$(nproc)

WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

echo "::group::Download GCC ${GCC_VERSION} source"
TARBALL="gcc-${GCC_VERSION}.tar.xz"
DOWNLOAD_URL="https://ftp.gnu.org/gnu/gcc/gcc-${GCC_VERSION}/${TARBALL}"
wget -q -O "${WORKDIR}/${TARBALL}" "${DOWNLOAD_URL}"
echo "::endgroup::"

echo "::group::Extract source"
cd "${WORKDIR}"
tar xf "${TARBALL}"
SRCDIR="${WORKDIR}/gcc-${GCC_VERSION}"
echo "::endgroup::"

echo "::group::Download GCC prerequisites (gmp, mpfr, mpc, isl)"
cd "${SRCDIR}"
./contrib/download_prerequisites
echo "::endgroup::"

echo "::group::Configure build"
BUILD_DIR="${WORKDIR}/build"
mkdir -p "${BUILD_DIR}"
cd "${BUILD_DIR}"

"${SRCDIR}/configure" \
    --prefix="${PREFIX}" \
    --enable-languages=c,c++,fortran \
    --disable-multilib \
    --disable-bootstrap \
    --disable-libsanitizer \
    --disable-werror
echo "::endgroup::"

echo "::group::Build (using ${NPROC} cores)"
make -j"${NPROC}"
echo "::endgroup::"

echo "::group::Install to ${PREFIX}"
mkdir -p "${PREFIX}"
make install
echo "::endgroup::"

echo "::group::Create gcc-toolset enable script"
# Create the enable script matching the format used by RPM-packaged gcc-toolset
cat > "${TOOLSET_ROOT}/enable" << 'ENABLE_EOF'
# Enable script for gcc-toolset-TOOLSET_NUMBER (built from source)
# Source this file to activate: source /opt/rh/gcc-toolset-TOOLSET_NUMBER/enable
export PATH=/opt/rh/gcc-toolset-TOOLSET_NUMBER/root/usr/bin${PATH:+:${PATH}}
export MANPATH=/opt/rh/gcc-toolset-TOOLSET_NUMBER/root/usr/share/man:${MANPATH:-}
export INFOPATH=/opt/rh/gcc-toolset-TOOLSET_NUMBER/root/usr/share/info${INFOPATH:+:${INFOPATH}}
export PCP_DIR=/opt/rh/gcc-toolset-TOOLSET_NUMBER/root
export LD_LIBRARY_PATH=/opt/rh/gcc-toolset-TOOLSET_NUMBER/root/usr/lib64:/opt/rh/gcc-toolset-TOOLSET_NUMBER/root/usr/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}
export PKG_CONFIG_PATH=/opt/rh/gcc-toolset-TOOLSET_NUMBER/root/usr/lib64/pkgconfig${PKG_CONFIG_PATH:+:${PKG_CONFIG_PATH}}
ENABLE_EOF

# Replace placeholder with actual toolset number
sed -i "s/TOOLSET_NUMBER/${TOOLSET}/g" "${TOOLSET_ROOT}/enable"
echo "::endgroup::"

echo "::group::Verify installation"
# Source the enable script and verify
source "${TOOLSET_ROOT}/enable"
gcc --version
g++ --version

echo "Installed to: ${TOOLSET_ROOT}"
echo "Activate with: source ${TOOLSET_ROOT}/enable"
echo "::endgroup::"
