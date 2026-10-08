#!/bin/bash
# Arm64 pre-script for building pytorch/audio in test_build_wheels_windows_arm64.yml.
# pytorch/audio does not ship an arm64 pre-script, and the arm64 build steps in
# build_wheels_windows.yml expect the pre-script to create .venv with torch installed.
# This runs from the audio checkout ($SRC_DIR).

set -ex

python -m pip install --upgrade pip
python -m venv .venv
echo "*" > .venv/.gitignore
source .venv/Scripts/activate

if [ "$CHANNEL" = "release" ]; then
  echo "Installing latest stable version of PyTorch."
  pip3 install --pre torch --index-url https://download.pytorch.org/whl/torch/
elif [ "$CHANNEL" = "test" ]; then
  echo "Installing PyTorch version $PYTORCH_VERSION."
  pip3 install --pre torch=="$PYTORCH_VERSION" --index-url https://download.pytorch.org/whl/test
else
  echo "Installing PyTorch from nightly."
  pip3 install --pre torch --index-url https://download.pytorch.org/whl/nightly/cpu
fi
