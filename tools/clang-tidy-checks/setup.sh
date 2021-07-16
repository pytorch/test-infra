#!/usr/bin/env bash

set -e

function unreachable() {
  echo "[fatal]: Hit unreachable code!"
  exit 1
}

function error() {
  echo "[error]:" "$1"
  exit 1
}

function info() {
  echo "[info]:" "$1"
}

function success() {
  echo "success!"
}

function check_requirements() {
  info "checking requirements"

  case $(uname) in
    Linux|Darwin)
      ;;
    *)
      error "Unsupported OS $(uname)"
      ;;
  esac

  cmake --version
  gcc --version
  python3 --version
  ninja --version
  ld.lld --version
  success
}

function clone_llvm() {
  info "cloning llvm"
  if [[ -d llvm-project ]]; then
    rm -rf llvm-project
  fi
  git clone -b llvmorg-11.0.0 https://github.com/llvm/llvm-project.git --depth=1
  success
}

function apply_patches() {
  info "applying patches"
  cd llvm-project
  for check in ../*.diff; do
    patch -p1 -N -d . < "$check"
  done
  success
}

function build() {
  local cmake_common_args=(
    -DCMAKE_C_COMPILER=clang
    -DCMAKE_CXX_COMPILER=clang++
    -DCMAKE_BUILD_TYPE=Release
    -DCLANG_ENABLE_STATIC_ANALYZER=OFF
    -DCLANG_ENABLE_ARCMT=OFF
    -DLLVM_ENABLE_PROJECTS="clang;clang-tools-extra"
    -DLLVM_BUILD_TOOLS=OFF
    -DLLVM_BUILD_UTILS=OFF
    -GNinja
  )

  local cmake_os_args

  case $(uname) in
    Linux)
      cmake_os_args=(
        -DLLVM_USE_LINKER=lld
        -DLLVM_BUILD_STATIC=ON
        -DCMAKE_CXX_FLAGS="-static"
      )
      ;;
    Darwin)
      cmake_os_args=(
        -DCMAKE_CXX_FLAGS="-static-libgcc -static-libstdc++"
        -DCMAKE_OSX_DEPLOYMENT_TARGET="10.15"
      )
      ;;
    *)
      unreachable
      ;;
  esac


  mkdir build
  cd build

  cmake "${cmake_common_args[@] cmake_os_args[@]}" ../llvm
  cmake --build . --target clang-tidy
  success
}

function setup() {
  clone_llvm
  apply_patches
  build
}

function check_if_static() {
  case $(uname) in
    Linux)
      ldd ./bin/clang-tidy 2>&1 | grep -q "not a dynamic executable"
      ;;
    Darwin)
      # No static link check for MacOS
      #
      # Apple makes it a little hard to build a fully statically linked binary.
      # It involves performing some hacks that move shared dynamic libraries to
      # particular directories. This adds a bit of complexity to the build
      # step. To keep things simple, we ignore this check.
      ;;
    *)
      unreachable
      ;;
  esac
}

function verify() {
  [[ -e ./bin/clang-tidy ]] && check_if_static
}

check_requirements
setup
verify
