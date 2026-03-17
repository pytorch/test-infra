#!/bin/bash
# PyTorch Test Script for L4 GPU
# Reads wheels from previous build step and runs tests
# Environment: linux-jammy-cuda12.8-py3.10-gcc11

set -euxo pipefail

echo "=== PyTorch Test Script ==="
echo "PREV_STEP_ARTIFACTS: ${PREV_STEP_ARTIFACTS:-not set}"
echo "OUTPUT_PATH: ${OUTPUT_PATH:-not set}"

# ============================================================================
# Install wheels from previous build step
# ============================================================================
echo "start === Install wheels from previous build ==="

if [ -z "${PREV_STEP_ARTIFACTS:-}" ]; then
    echo "ERROR: PREV_STEP_ARTIFACTS not set. This script requires wheels from build step."
    exit 1
fi

# List available artifacts
echo "Available artifacts in PREV_STEP_ARTIFACTS:"
ls -la "$PREV_STEP_ARTIFACTS"/ 2>/dev/null || echo "No artifacts found!"

# Install PyTorch wheel
TORCH_WHEEL=$(ls "$PREV_STEP_ARTIFACTS"/torch*.whl 2>/dev/null | head -1)
if [ -n "$TORCH_WHEEL" ]; then
    echo "Installing PyTorch: $TORCH_WHEEL"
    pip install --no-index --no-deps "$TORCH_WHEEL"
else
    echo "ERROR: No PyTorch wheel found!"
    exit 1
fi

echo "end === Install wheels from previous build ==="

# ============================================================================
# Download and extract custom_test_artifacts from build step
# ============================================================================
echo "start === Restore custom_test_artifacts ==="

CUSTOM_ARTIFACTS_TAR="$PREV_STEP_ARTIFACTS/custom_test_artifacts.tar.gz"
if [ -f "$CUSTOM_ARTIFACTS_TAR" ]; then
    echo "Found custom_test_artifacts.tar.gz, extracting..."
    mkdir -p build
    tar -xzf "$CUSTOM_ARTIFACTS_TAR" -C build/
    echo "Extracted custom_test_artifacts:"
    ls -la build/custom_test_artifacts/ 2>/dev/null || echo "Warning: extraction may have failed"
else
    echo "Warning: custom_test_artifacts.tar.gz not found at $CUSTOM_ARTIFACTS_TAR"
    echo "Creating empty directory to avoid realpath error..."
    mkdir -p build/custom_test_artifacts
fi

echo "end === Restore custom_test_artifacts ==="

# ============================================================================
# Verify installation
# ============================================================================
echo "=== Verifying installation ==="
(cd / && python -c "import torch; print('PyTorch version:', torch.__version__)")
(cd / && python -c "import torch; print('CUDA available:', torch.cuda.is_available())")
(cd / && python -c "import triton; print('Triton version:', triton.__version__)" 2>/dev/null || echo "Triton not installed")

# ============================================================================
# Test environment setup
# ============================================================================
echo "start === Setup test environment ==="
# Check GPU
echo ""
echo "=== GPU Info ==="
nvidia-smi || echo "No GPU available"

echo "=== PyTorch Test Environment ==="
echo "TEST_CONFIG: ${TEST_CONFIG:-not set}"
echo "SHARD_NUMBER: ${SHARD_NUMBER:-not set}"
echo "NUM_TEST_SHARDS: ${NUM_TEST_SHARDS:-not set}"
echo "BUILD_ENVIRONMENT: ${BUILD_ENVIRONMENT:-not set}"
echo "TORCH_CUDA_ARCH_LIST: ${TORCH_CUDA_ARCH_LIST:-not set}"
echo "================================"

# Run actual PyTorch tests
bash .ci/pytorch/test.sh
