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

Write-Output "Installing Miniconda to $installationDir"
$argsList = "/InstallationType=JustMe /RegisterPython=0 /S /AddToPath=0 /D=$installationDir"
Start-Process -FilePath "$downloadDir\$condaFileName" -ArgumentList "$argsList" -Wait -NoNewWindow -PassThru

$condaExe = "$installationDir\Scripts\conda.exe"
if (-Not (Test-Path -Path $condaExe -PathType Leaf)) {
  Write-Error "Miniconda installation failed, no executable found at $condaExe"
  exit 1
}

Write-Output "Installing some common conda packages"
# The list of dependencies is copied from the current PyTorch miniconda installation script
$pythonDeps = 'numpy"<1.23" ninja pyyaml setuptools cmake cffi typing_extensions future six requests dataclasses boto3 libuv'
Start-Process -FilePath $condaExe -ArgumentList "install -y $pythonDeps" -Wait -NoNewWindow -PassThru
$cmakeDep = "-c conda-forge cmake=3.22.3"
Start-Process -FilePath $condaExe -ArgumentList "install -y $cmakeDep" -Wait -NoNewWindow -PassThru

# Clear out temp files
Remove-Item -Path "$env:TEMP\*" -Recurse -Force -ErrorAction SilentlyContinue
