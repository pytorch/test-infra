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

# Some dependencies are installed by pip before testing, copying them exactly
pip install "ninja==1.10.0.post1" future "hypothesis==5.35.1" "expecttest==0.1.3" "librosa>=0.6.2" "scipy==1.6.3" "psutil==5.9.1" "pynvml==11.4.1" pillow "unittest-xml-reporting<=3.2.0,>=2.0.0" pytest pytest-xdist pytest-rerunfailures
