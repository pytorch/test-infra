#!/bin/bash
# PyTorch Smoke Test Script
# Image: ghcr.io/pytorch/pytorch-test:2.11.0-cuda12.9-cudnn9-devel
# Repo patched in via --patch (provides .ci/ scripts)

set -euxo pipefail

echo "=== PyTorch Smoke Test ==="

cat /etc/os-release || echo "WARNING: /etc/os-release not found"

nvidia-smi || echo "WARNING: no GPU"

# Run python from / to avoid importing torch source tree instead of installed package
(cd / && python -c "
import torch
print('PyTorch version:', torch.__version__)
print('CUDA available:', torch.cuda.is_available())
print('CUDA version:', torch.version.cuda)
print('cuDNN version:', torch.backends.cudnn.version())
if torch.cuda.is_available():
    print('GPU:', torch.cuda.get_device_name(0))
")

echo "=== Running .ci/pytorch/smoke_test/smoke_test.py ==="
if [ -f .ci/pytorch/smoke_test/smoke_test.py ]; then
    # Rename repo's torch/ directory so it can't shadow the installed torch package
    mv torch torch_src_DO_NOT_IMPORT
    # Copy smoke_test out of repo tree
    cp -r .ci/pytorch/smoke_test /tmp/smoke_test_run
    # smoke_test.py reads these env vars for expected CUDA version
    export MATRIX_GPU_ARCH_VERSION="12.9"
    export DESIRED_CUDA="cu129"
    # Only test torch (skip torchvision/torchaudio which aren't in this image)
    export MATRIX_PACKAGE_TYPE="wheel"
    (cd /tmp/smoke_test_run && python smoke_test.py --package torchonly)
else
    echo "ERROR: .ci/pytorch/smoke_test/smoke_test.py not found"
    echo "Contents of .ci/pytorch/smoke_test/:"
    ls -la .ci/pytorch/smoke_test/ 2>/dev/null || echo ".ci/pytorch/smoke_test/ directory not found"
    exit 1
fi
