#!/bin/bash
# PyTorch Patch Test Script for L4 GPU
# Environment: linux-jammy-cuda12.8-py3.10-gcc11
#
# Usage:
#   elaine run-steps \
#     --step test_patch --script .ci/re_patch_example_g6.sh \
#     --patch \
#     --image "308535385114.dkr.ecr.us-east-1.amazonaws.com/pytorch/ci-image:..." \
#     --task-type gpu-l4 \
#     -f
#
# Runner.sh


set -euxo pipefail

# ============================================================================
# Environment Configuration
# ============================================================================
echo "=== Environment ==="
echo "CPUs: $(nproc)"

export CC=gcc-11
export CXX=g++-11
export MAX_JOBS=$(($(nproc) - 2))
export USE_MKLDNN=1

python --version
echo "Max jobs: $MAX_JOBS"

# ============================================================================
# to PyTorch directory use REPO_DIR（setted by runner.sh)
# ============================================================================
if [ -n "${REPO_DIR:-}" ]; then
    echo "=== access patched repo: $REPO_DIR ==="
    cd "$REPO_DIR"
else
    echo "ERROR: REPO_DIR not set. Did you use --patch?"
    echo "Usage: elaine run-steps --step test --script .ci/re_patch_example_g6.sh --patch -f"
    exit 1
fi

echo "Building from: $(pwd)"
echo "Git HEAD: $(git rev-parse HEAD)"

# 显示 patch 的改动
echo "=== Patch changes ==="
git diff --stat HEAD~1 HEAD 2>/dev/null || git status

# ============================================================================
# 运行测试
# ============================================================================
echo "=== Running test_patch.py ==="
python benchmarks/test_patch.py
echo "=== Done! ==="
