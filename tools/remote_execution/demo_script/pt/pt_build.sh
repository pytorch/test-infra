#!/bin/bash
# PyTorch Build Script for L4 GPU
# Environment: linux-jammy-cuda12.8-py3.10-gcc11
# Test Config: default
# example img: 308535385114.dkr.ecr.us-east-1.amazonaws.com/pytorch/ci-image:pytorch-linux-jammy-cuda12.8-cudnn9-py3-gcc11-1e1d015a6487b8ad1fc25326f4e80a62ab21107f
#https://github.com/pytorch/pytorch/actions/runs/21910206459/job/63263254553


# elaine run-steps \
#    --step build --script demo_script/gpu/l4_g6linux_build_example.sh --type cpu-large-memory -e pytorch-linux-jammy-cuda12.8-cudnn9-py3-gcc11\
#    --step test --script  demo_script/gpu/l4_g6linux_test_example.sh --type gpu-l4 -e pytorch-linux-jammy-cuda12.8-cudnn9-py3-gcc11 \
#    --image "308535385114.dkr.ecr.us-east-1.amazonaws.com/pytorch/ci-image:pytorch-linux-jammy-cuda12.8-cudnn9-py3-gcc11-1e1d015a6487b8ad1fc25326f4e80a62ab21107f" \
#    --follow \
#    --patch

set -euxo pipefail

# ============================================================================
# Environment Configuration for L4 GPU (no conda)
# ============================================================================
echo hello && nproc

echo "build_env: $BUILD_ENVIRONMENT"
export BUILD_ENVIRONMENT

# CUDA architectures to build for (can be overridden via -e flag)
export TORCH_CUDA_ARCH_LIST
echo "TORCH_CUDA_ARCH_LIST: $TORCH_CUDA_ARCH_LIST"

# Dynamically adjust MAX_JOBS based on available memory to avoid OOM
TOTAL_MEM_GB=$(awk '/MemTotal/ { printf "%d", $2/1024/1024 }' /proc/meminfo)
NPROC=$(nproc)
echo "Detected total memory: ${TOTAL_MEM_GB}GB, nproc: ${NPROC}"

if [ "$TOTAL_MEM_GB" -ge 180 ]; then
    export MAX_JOBS=$((NPROC - 2))
    export FLASH_ATTENTION_JOBS=24
else
    export MAX_JOBS=$((NPROC - 4))
    export FLASH_ATTENTION_JOBS=2
fi
# Ensure MAX_JOBS is at least 1
if [ "$MAX_JOBS" -lt 1 ]; then
    export MAX_JOBS=1
fi
echo "MAX_JOBS=${MAX_JOBS}, FLASH_ATTENTION_JOBS=${FLASH_ATTENTION_JOBS}"

export PATH="/opt/cache/bin:$PATH"
if which sccache > /dev/null 2>&1; then
    export SCCACHE_BUCKET="remote-execution-pytorch-re-prod-production"
    export SCCACHE_REGION="us-east-2"
    export SCCACHE_S3_KEY_PREFIX="torch_cache_2/${BUILD_ENVIRONMENT}"
    export SCCACHE_S3_USE_SSL=true
    sccache --stop-server > /dev/null 2>&1 || true
    SCCACHE_ERROR_LOG=~/sccache_error.log SCCACHE_IDLE_TIMEOUT=0 RUST_LOG=sccache::server=error sccache --start-server || true
    sccache --zero-stats || true
    echo "sccache enabled (S3 backend: s3://remote-execution-pytorch-re-prod-production/torch_cache/)"
else
    echo "sccache not found, building without cache"
fi

echo "start === Build PyTorch (using .ci/pytorch/build.sh) ==="
export PYTHONUNBUFFERED=1

# Start heartbeat process to show build is alive (every 60 seconds)
(
    while true; do
        sleep 180
        if pgrep -f "ninja" > /dev/null 2>&1; then
            COMPILE_REQS=$(sccache --show-stats 2>/dev/null | awk '/Compile requests executed/ {print $NF}' || echo "?")
            CACHE_HITS=$(sccache --show-stats 2>/dev/null | awk '/^Cache hits / {print $NF}' | head -1 || echo "?")
            echo "[Heartbeat] Build running... compiled: $COMPILE_REQS, cache hits: $CACHE_HITS"
        elif pgrep -f "cicc\|ptxas\|nvcc" > /dev/null 2>&1; then
            echo "[Heartbeat] CUDA compilation in progress..."
        fi
    done
) &
HEARTBEAT_PID=$!

# Run the build
bash .ci/pytorch/build.sh
BUILD_EXIT_CODE=$?

# Stop heartbeat
kill $HEARTBEAT_PID 2>/dev/null || true

if [ $BUILD_EXIT_CODE -ne 0 ]; then
    echo "Build failed with exit code $BUILD_EXIT_CODE"
    exit $BUILD_EXIT_CODE
fi
echo "end === Build PyTorch ==="
echo "Build complete!"

# OUTPUT_PATH is automatically set by runner
echo "OUTPUT_PATH: $OUTPUT_PATH"
echo "start === Save build artifacts ==="

# Copy build outputs to OUTPUT_PATH (runner will upload to S3)
if [ -n "${OUTPUT_PATH:-}" ]; then
    mkdir -p "$OUTPUT_PATH"

    # Copy PyTorch wheel (we're in PYTORCH_DIR)
    cp dist/*.whl "$OUTPUT_PATH/" 2>/dev/null || true

    # Tar and copy custom_test_artifacts for test step
    if [ -d "build/custom_test_artifacts" ]; then
        echo "Creating custom_test_artifacts.tar.gz..."
        tar -czf build/custom_test_artifacts.tar.gz -C build custom_test_artifacts/
        cp build/custom_test_artifacts.tar.gz "$OUTPUT_PATH/"
        echo "custom_test_artifacts.tar.gz created"
    else
        echo "Warning: build/custom_test_artifacts not found, skipping"
    fi

    echo "=== Build artifacts in OUTPUT_PATH ==="
    ls -la "$OUTPUT_PATH/"
fi
