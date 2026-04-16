#!/bin/bash
# Run PyTorch smoke test using pre-built GHCR image
# Image: ghcr.io/pytorch/pytorch-test:2.11.0-cuda12.9-cudnn9-devel
# --patch: sync local pytorch repo (for .ci scripts)
# --no-submodule: skip submodule init (not needed for smoke test)

blast run-steps \
  --step smoke-test --script demo_script/pt/pt_smoke_test.sh --type gpu-l4 \
  --image "ghcr.io/pytorch/pytorch-test:2.11.0-cuda12.9-cudnn9-devel" \
  --patch --no-submodule \
  --follow
