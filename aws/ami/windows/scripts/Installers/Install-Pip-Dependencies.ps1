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
pip install "ninja==1.10.0.post1" "future==0.18.2" "hypothesis==5.35.1" "expecttest==0.1.3" "librosa>=0.6.2" "scipy==1.6.3" "psutil==5.9.1" "pynvml==11.4.1" "pillow==9.2.0" "unittest-xml-reporting<=3.2.0,>=2.0.0" "pytest==7.1.3" "pytest-xdist==2.5.0" "pytest-flakefinder==1.1.0" "pytest-rerunfailures==10.2" "pytest-shard==0.1.2" "sympy==1.11.1" "xdoctest==1.0.2" "pygments==2.12.0" "opt-einsum>=3.3" "networkx==2.8.8" "mpmath==1.2.1" "pytest-rerunfailures==10.2" "pytest-cpp==2.3.0" "rockset==1.0.3"
