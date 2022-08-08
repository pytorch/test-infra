function New-TemporaryDirectory() {
  New-TemporaryFile | ForEach-Object { Remove-Item $_; New-Item -ItemType Directory -Path $_ }
}

# This is the same directory currently used by PyTorch GHA, so we keep using it
# for backward compatibility
$parentDir = "C:\Jenkins"
$installationDir = "$parentDir\Miniconda3"
$downloadDir = New-TemporaryDirectory

if (-Not (Test-Path -Path $parentDir)) {
  New-Item -Path $parentDir -ItemType "directory"
}

$condaFilename = "Miniconda3-latest-Windows-x86_64.exe"
$condaURI = "https://repo.anaconda.com/miniconda/$condaFileName"

Write-Output "Downloading Miniconda from $condaURI to $downloadDir, please wait ..."
Invoke-WebRequest -Uri $condaURI -OutFile "$downloadDir\$condaFileName"

# https://docs.conda.io/projects/conda/en/latest/user-guide/install/windows.html
$argsList = "/InstallationType=AllUsers /RegisterPython=0 /S /D=$installationDir"

Write-Output "Installing Miniconda to $installationDir"
Start-Process -FilePath "$downloadDir\$condaFileName" -ArgumentList "$argsList" -Wait -NoNewWindow -PassThru

$condaHook = "$installationDir\shell\condabin\conda-hook.ps1"
if (-Not (Test-Path -Path $condaHook -PathType Leaf)) {
  Write-Error "Miniconda installation failed, no hook found at $condaHook"
  exit 1
}

# Load conda into powershell
& $condaHook
# and activate it (without this, python and pip commands won't be recognized)
conda activate base

Write-Output "Installing conda and pip packages for building and testing PyTorch"
# The list of dependencies is copied from the current PyTorch miniconda installation script
conda install -y numpy"<1.23" ninja pyyaml setuptools cmake cffi typing_extensions future six requests dataclasses boto3 libuv
conda install -y -c conda-forge cmake=3.22.3
# and setup_pytorch_env script
conda install -y mkl protobuf numba scipy=1.6.2 typing_extensions dataclasses
# Some dependencies are installed by pip, copying them exactly
pip install "ninja==1.10.0.post1" future "hypothesis==5.35.1" "expecttest==0.1.3" "librosa>=0.6.2" "scipy==1.6.3" "psutil==5.9.1" "pynvml==11.4.1" pillow "unittest-xml-reporting<=3.2.0,>=2.0.0" pytest pytest-xdist pytest-rerunfailures

# Clean up the temp file
Remove-Item -Path "$downloadDir\*" -Recurse -Force -ErrorAction SilentlyContinue
