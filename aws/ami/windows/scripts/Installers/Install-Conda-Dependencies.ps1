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
# Keep pins here to a minimum: conda records each one in the base env history and
# every later solve in base, e.g. `conda install conda=...` in CI, must satisfy it.
# conda stays at the installer's version: conda>=26 drops the implicit defaults
# channel that CI relies on.
conda install -y conda=25.3.1 mkl protobuf numba scipy typing_extensions numpy ninja `
pyyaml setuptools cmake=3.22.* cffi future six requests boto3 libuv
