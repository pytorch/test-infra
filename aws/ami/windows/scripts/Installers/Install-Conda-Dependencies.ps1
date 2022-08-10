$parentDir = "C:\Jenkins"
$installationDir = "$parentDir\Miniconda3"

$condaHook = "$installationDir\shell\condabin\conda-hook.ps1"
if (-Not (Test-Path -Path $condaHook -PathType Leaf)) {
  Write-Error "Miniconda installation failed, no hook found at $condaHook"
  exit 1
}

# Load conda into powershell
& $condaHook
# and activate it (without this, python and pip commands won't be recognized)
conda activate base

Write-Output "Installing conda packages for building and testing PyTorch"
# The list of dependencies is copied from the current PyTorch miniconda installation script
conda install -y numpy"<1.23" ninja pyyaml setuptools cmake cffi typing_extensions future six requests dataclasses boto3 libuv
conda install -y -c conda-forge cmake=3.22.3
# and setup_pytorch_env script
conda install -y mkl protobuf numba scipy=1.6.2 typing_extensions dataclasses
