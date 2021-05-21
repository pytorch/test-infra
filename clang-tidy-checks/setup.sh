#!/usr/bin/env bash

function info() {
  echo "[info]: " $1
}

function success() {
  echo "success!"
}

function check_requirements() {
  info "checking requirements"
  cmake --version &&
  gcc --version &&
  python3 --version &&
  ninja --version &&
  lld --version &&
  success
}

function clone_llvm() {
  info "cloing llvm"
  git clone https://github.com/llvm/llvm-project.git &&
  git fetch --all --tags &&
  git checkout -b tags/llvmorg-11.0.0 &&
  success
}

function apply_patches() {
  info "applying patches"
  cd llvm-project
  patch potential-unbounded-loop-check.diff &&
  success
}

function build() {
  mkdir build
  cd build
  cmake -DCMAKE_C_COMPILER=clang \
        -DCMAKE_CXX_COMPILER=clang++ \
        -DCMAKE_BUILD_TYPE=Release \
        -DLLVM_ENABLE_PROJECTS=clang,clang-tools-extra \
        -DLLVM_USE_LINKER=lld \
        -DLLVM_TARGETS_TO_BUILD="X86" \
        -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
        -DCLANG_ENABLE_ARCMT=OFF \
        -DLLVM_BUILD_TOOLS=OFF \
        -DLLVM_BUILD_UTILS=OFF \
        -DCMAKE_CXX_FLAGS_RELEASE="-O0" \
        -GNinja ../llvm  &&
  ninja
}

function setup() {
  clone_llvm &&
  apply_patches &&
  build
}

check_requirements && setup
