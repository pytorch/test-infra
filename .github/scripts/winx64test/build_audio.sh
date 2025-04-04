#!/bin/bash

echo "Building audio dependencies and wheel started."

# Set environment variables
export SRC_PATH="$GITHUB_WORKSPACE/$SRC_DIR"
export VCVARSALL_PATH="$DEPENDENCIES_DIR/VSBuildTools/VC/Auxiliary/Build/vcvarsall.bat"
export CONDA_PREFIX="$DEPENDENCIES_DIR"
export PATH="$PATH:$CONDA_PREFIX/Library/bin"
export DISTUTILS_USE_SDK=1
export USE_FFMPEG=1
export FFMPEG_ROOT="$DEPENDENCIES_DIR/Library"
export TRIPLET_FILE="triplets/x64-windows.cmake"

echo "CONDA_PREFIX: $CONDA_PREFIX"
echo "SRC_PATH: $SRC_PATH"
echo "VCVARSALL_PATH: $VCVARSALL_PATH"
echo "PATH: $PATH"

# Dependencies
mkdir -p "$DOWNLOADS_DIR"
mkdir -p "$DEPENDENCIES_DIR"
echo "*" > "$DOWNLOADS_DIR/.gitignore"
echo "*" > "$DEPENDENCIES_DIR/.gitignore"

# Install vcpkg
cd "$DOWNLOADS_DIR" || exit
git clone https://github.com/microsoft/vcpkg.git -b 2024.07.12
cd vcpkg || exit
./bootstrap-vcpkg.sh

# Set vcpkg to only build release packages
echo "set(VCPKG_BUILD_TYPE release)" >> "$TRIPLET_FILE"

# Install dependencies using vcpkg
./vcpkg install ffmpeg[ffmpeg]:x64-windows --x-install-root="$DEPENDENCIES_DIR"

# Copy files using cp (replace robocopy)
mkdir -p "$DEPENDENCIES_DIR/Library/"
cp -r "$DEPENDENCIES_DIR/x64-windows/"* "$DEPENDENCIES_DIR/Library"
cp -r "$DEPENDENCIES_DIR/Library/tools/ffmpeg/"* "$DEPENDENCIES_DIR/Library/bin"
cp -r "$DEPENDENCIES_DIR/Library/bin/"* "$SRC_PATH/src/torio/lib"

# Test ffmpeg installation
echo "$FFMPEG_ROOT"
ffmpeg -version

# Source directory
cd "$SRC_PATH" || exit

# Create virtual environment
python -m pip install --upgrade pip
python -m venv .venv
echo "*" > .venv/.gitignore
source .venv/Scripts/activate

# Install dependencies
pip install --pre torch --index-url https://download.pytorch.org/whl/nightly/cpu

# Create wheel under dist folder
python setup.py bdist_wheel

# Check if build was successful
if [[ $? -ne 0 ]]; then
    echo "Failed on build_audio. (exitcode = $?)"
    exit 1
fi

echo "Build finished successfully."
