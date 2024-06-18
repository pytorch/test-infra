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

# Miniconda3-latest-Windows-x86_64 nows use Python3.10 which will causes conflicts
# later on when installing
$condaFilename = "Miniconda3-py39_22.11.1-1-Windows-x86_64.exe"
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

# Clean up the temp file
Remove-Item -Path "$downloadDir\*" -Recurse -Force -ErrorAction SilentlyContinue

# https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_profiles
$PS_PROFILE = "$PSHOME\Microsoft.PowerShell_profile.ps1"

$PYTHON_PATH = '$Env:PATH += ' + "';$installationDir'"

# Add conda path to the powershell profile to make its commands, i.e. python, available when logging
# in to Windows runners or when the CI uses powershell
Add-Content "$PS_PROFILE" "$PYTHON_PATH"

$Env:PATH += ";$installationDir"
