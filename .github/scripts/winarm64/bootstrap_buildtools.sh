#!/bin/bash

echo "Dependency MSVC Build Tools with C++ with ARM64/ARM64EC components installation started."

# Pre-check for downloads and dependencies folders
mkdir -p "$DOWNLOADS_DIR"
mkdir -p "$DEPENDENCIES_DIR"

# Set download URL for the Visual Studio Installer
DOWNLOAD_URL="https://aka.ms/vs/17/release/vs_BuildTools.exe"
INSTALLER_FILE="$DOWNLOADS_DIR/vs_BuildTools.exe"

# Download installer
echo "Downloading Visual Studio Build Tools with C++ installer..."
curl -L -o "$INSTALLER_FILE" "$DOWNLOAD_URL"

# Install the Visual Studio Build Tools with C++ components
echo "Installing Visual Studio Build Tools with C++ components..."
echo "Installing MSVC $MSVC_VERSION"
"$INSTALLER_FILE" --norestart --quiet --wait --installPath "$DEPENDENCIES_DIR/VSBuildTools" \
    --add Microsoft.VisualStudio.Workload.VCTools \
    --add Microsoft.VisualStudio.Component.Windows10SDK \
    --add Microsoft.VisualStudio.Component.Windows11SDK.22621 \
    --add Microsoft.VisualStudio.Component.VC.ASAN \
    --add Microsoft.VisualStudio.Component.VC.CMake.Project \
    --add Microsoft.VisualStudio.Component.VC.CoreBuildTools \
    --add Microsoft.VisualStudio.Component.VC.CoreIde \
    --add Microsoft.VisualStudio.Component.VC.Redist.14.Latest \
    --add Microsoft.VisualStudio.Component.VC.Tools.ARM64EC \
    --add Microsoft.VisualStudio.Component.VC.Tools.ARM64 \
    --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64

# Check if installation was successful
if [[ $? -ne 0 ]]; then
    echo "Failed to install Visual Studio Build Tools with C++ components."
    exit 1
fi

echo "Dependency Visual Studio Build Tools with C++ installation finished."