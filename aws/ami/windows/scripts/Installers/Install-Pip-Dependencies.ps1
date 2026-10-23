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

# Some dependencies are installed by pip before testing, pin all of them
pip install "ninja==1.13.0" "future==1.0.0" "hypothesis==6.56.4" "expecttest==0.3.0" "librosa>=0.6.2" "scipy==1.16.2" "psutil==7.1.0" "pynvml==11.4.1" "pillow==12.3.0" "unittest-xml-reporting<=3.2.0,>=2.0.0" "pytest==7.3.2" "pytest-xdist==3.3.1" "pytest-flakefinder==1.1.0" "pytest-shard==0.1.2" "sympy==1.13.3" "xdoctest==1.3.0" "pygments==2.20.0" "opt-einsum>=3.3" "networkx==2.8.8" "mpmath==1.2.1" "pytest-rerunfailures==10.3" "pytest-cpp==2.3.0"
