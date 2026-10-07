#!/usr/bin/env bash
# Cross-compile the in-pod RPC server to static musl binaries for amd64 + arm64.
# Output: packages/k8s/rpc-server/binaries/rpc-server-{amd64,arm64} (gitignored).
#
# Requirements (zero system packages, no Docker):
#   - rustup with the x86_64-unknown-linux-musl and aarch64-unknown-linux-musl
#     targets installed (`rustup target add ...`).
#
# The crate is pure Rust (tiny_http + libc, no C deps), so we link with the
# `rust-lld` that ships inside the toolchain and let rustc supply the musl CRT
# objects (`-C link-self-contained=yes`). This needs neither `cross`/Docker nor
# a musl-gcc / aarch64 cross-gcc from apt — the previous `cross` setup broke in
# CI with a host/container glibc mismatch ("GLIBC_2.28 not found" while building
# the libc crate's build script).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CRATE="$HERE/../rpc-server"
OUT="$CRATE/binaries"
mkdir -p "$OUT"

# Locate the bundled rust-lld for the *host* triple. It's a cross-linker (LLVM
# lld handles every target arch), so one binary links both musl targets.
HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
SYSROOT="$(rustc --print sysroot)"
RUST_LLD="$SYSROOT/lib/rustlib/$HOST_TRIPLE/bin/rust-lld"
if [ ! -x "$RUST_LLD" ]; then
  echo "rust-lld not found at $RUST_LLD" >&2
  echo "Install the llvm-tools (it ships with the standard toolchain)." >&2
  exit 1
fi

LINK_FLAGS="-C linker=$RUST_LLD -C linker-flavor=ld.lld -C link-self-contained=yes"

build_target() {
  local target="$1"
  local out_name="$2"

  ( cd "$CRATE" && RUSTFLAGS="$LINK_FLAGS" cargo build --release --target "$target" )

  cp "$CRATE/target/$target/release/rpc-server" "$OUT/$out_name"
  chmod +x "$OUT/$out_name"

  local size
  size=$(wc -c < "$OUT/$out_name")
  echo "built $out_name: $size bytes"
}

build_target x86_64-unknown-linux-musl rpc-server-amd64
build_target aarch64-unknown-linux-musl rpc-server-arm64
