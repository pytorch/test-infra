#!/bin/bash
# blast run --script ./demo_script/vllm/vllm-test.sh --image public.ecr.aws/q9t5s3a7/vllm-ci-test-repo:d4191e9393ea6af8c0148fa183148bf1fea533a2 --type gpu-l4 --name vllm-starcoder2-test --follow
# https://buildkite.com/vllm/ci/builds/56028/steps/canvas?sid=019ce4cd-6579-4f0c-84f2-8dbf91c8d6ef
set -e

cd /vllm-workspace/tests

nvidia-smi || true

echo "Python version:"
python3 --version
echo "PyTorch version:"
python3 -c "import torch; print(torch.__version__)"

set -e

cd /vllm-workspace/tests

nvidia-smi || true

echo "Python version:"
python3 --version
echo "PyTorch version:"
python3 -c "import torch; print(torch.__version__)"

export CUDA_ENABLE_COREDUMP_ON_EXCEPTION=1
export CUDA_COREDUMP_SHOW_PROGRESS=1
export CUDA_COREDUMP_GENERATION_FLAGS="skip_nonrelocated_elf_images,skip_global_memory,skip_shared_memory,skip_local_memory,skip_constbank_memory"

echo "Building wheels... mamba@v2.3.0 ~ 10mins"
pip wheel --no-build-isolation "git+https://github.com/state-spaces/mamba@v2.3.0" -w /tmp/wheels
echo "Building wheels... causal-conv1d@v1.6.0 ~ 10mins"
pip wheel --no-build-isolation "git+https://github.com/Dao-AILab/causal-conv1d@v1.6.0" -w /tmp/wheels
echo "Installing wheels..."
pip install /tmp/wheels/*.whl
echo "Saving wheels to OUTPUT_PATH..."

mkdir -p "$OUTPUT_PATH/wheels"
cp /tmp/wheels/*.whl "$OUTPUT_PATH/wheels/"
echo "Saved wheels:"
ls -lh "$OUTPUT_PATH/wheels/"

echo "run tests..."
pytest -v -s "models/language/generation/test_common.py::test_models[False-False-5-32-bigcode/starcoder2-3b]"
