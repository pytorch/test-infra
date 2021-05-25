#!/usr/bin/env bash

set -e

function info() {
  echo "[info]:" "$1"
}

function success() {
  echo "success!"
}

function check_requirements() {
  info "checking requirements"
  cmake --version
  gcc --version
  python3 --version
  ninja --version
  ld.lld --version
  success
}

function clone_llvm() {
  info "cloning llvm"
  git clone -b llvmorg-11.0.0 https://github.com/llvm/llvm-project.git --depth=1
  success
}

function apply_patches() {
  info "applying patches"
  cd llvm-project
  cat ../potential-unbounded-loop-check.diff | patch -p1 -N -d .
  success
}

function build() {
  mkdir build
  cd build
  cmake -DCMAKE_C_COMPILER=clang \
        -DCMAKE_CXX_COMPILER=clang++ \
        -DCMAKE_BUILD_TYPE=RelWithDebInfo \
        -DLLVM_ENABLE_PROJECTS=clang,clang-tools-extra \
        -DLLVM_USE_LINKER=lld \
        -DLLVM_TARGETS_TO_BUILD="X86" \
        -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
        -DCLANG_ENABLE_ARCMT=OFF \
        -DLLVM_BUILD_TOOLS=OFF \
        -DLLVM_BUILD_UTILS=OFF \
        -GNinja ../llvm
  cmake --build build
}

function setup() {
  clone_llvm
  apply_patches
  build
}

check_requirements
setup
