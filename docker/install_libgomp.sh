#!/bin/bash
# Build a newer libgomp from GCC 13.3.0 source for aarch64.
# The version shipped with AlmaLinux 8 is too old for PyTorch builds.
# Adapted from PyTorch CI: .ci/docker/common/install_libgomp.sh

set -ex

# Install build dependencies
dnf -y install gmp-devel libmpc-devel texinfo flex bison

cd /usr/local/src
git clone --depth 1 --single-branch -b releases/gcc-13.3.0 \
    https://github.com/gcc-mirror/gcc.git gcc-13.3.0

mkdir -p gcc-13.3.0/build-gomp
cd gcc-13.3.0/build-gomp

OPT_FLAGS='-O2 -march=armv8-a -mtune=generic'\
' -fexceptions -g -grecord-gcc-switches -pipe -Wall'\
' -Wp,-D_FORTIFY_SOURCE=2 -Wp,-D_GLIBCXX_ASSERTIONS'\
' -fstack-protector-strong -fasynchronous-unwind-tables'\
' -fstack-clash-protection'

LDFLAGS='-Wl,-z,relro -Wl,--as-needed -Wl,-z,now'

CFLAGS="$OPT_FLAGS" \
CXXFLAGS="$OPT_FLAGS" \
LDFLAGS="$LDFLAGS" \
../configure \
    --prefix=/usr \
    --libdir=/usr/lib64 \
    --enable-languages=c,c++ \
    --disable-multilib \
    --disable-bootstrap \
    --enable-libgomp

make -j"$(nproc)" all-target-libgomp
make install-target-libgomp

# Clean up source tree
rm -rf /usr/local/src/gcc-13.3.0
