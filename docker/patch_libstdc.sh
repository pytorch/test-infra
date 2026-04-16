#!/bin/bash
# Workaround for exposing statically linked libstdc++ CXX11 ABI symbols.
# See: https://github.com/pytorch/pytorch/issues/133437
# Adapted from PyTorch CI: .ci/docker/common/patch_libstdc.sh

set -xe

LIBNONSHARED=$(gcc -print-file-name=libstdc++_nonshared.a)
nm -g "$LIBNONSHARED" | grep " T " | grep recursive_directory_iterator | cut -c 20- > weaken-symbols.txt
objcopy --weaken-symbols weaken-symbols.txt "$LIBNONSHARED" "$LIBNONSHARED"
rm -f weaken-symbols.txt
