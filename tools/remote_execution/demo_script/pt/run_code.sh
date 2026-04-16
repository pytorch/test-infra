blast run-steps \
  --step build --script demo_script/pt/pt_build.sh --type cpu-44 \
  -e "TEST_CONFIG=default,SHARD_NUMBER=1,NUM_TEST_SHARDS=5,BUILD_ENVIRONMENT=linux-jammy-cuda13.0-py3.10-gcc11,TORCH_CUDA_ARCH_LIST=8.9" \
  --image "308535385114.dkr.ecr.us-east-1.amazonaws.com/pytorch/ci-image:pytorch-linux-jammy-cuda13.0-cudnn9-py3-gcc11-8b6c10a0d432ae45b44f1f6195ece074ea40c0d0" \
  --step test --script demo_script/pt/pt_test.sh --type gpu-l4 \
  -e "TEST_CONFIG=default,SHARD_NUMBER=1,NUM_TEST_SHARDS=5,BUILD_ENVIRONMENT=linux-jammy-cuda13.0-py3.10-gcc11,TORCH_CUDA_ARCH_LIST=8.9" \
  --image "308535385114.dkr.ecr.us-east-1.amazonaws.com/pytorch/ci-image:pytorch-linux-jammy-cuda13.0-cudnn9-py3-gcc11-8b6c10a0d432ae45b44f1f6195ece074ea40c0d0" \
  --patch --follow
