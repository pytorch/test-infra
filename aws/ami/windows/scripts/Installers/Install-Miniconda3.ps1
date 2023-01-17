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

# Clean up the temp file
Remove-Item -Path "$downloadDir\*" -Recurse -Force -ErrorAction SilentlyContinue

# https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_profiles
$PS_PROFILE = "$PSHOME\Microsoft.PowerShell_profile.ps1"

$Env:PATH += ";$installationDir"
# Add conda path to the powershell profile to make its commands available when logging in to Windows
# runners, for example python
Add-Content "$PS_PROFILE" '$Env:PATH += ' + "';$installationDir'"

# According to https://docs.conda.io/en/latest/miniconda.html, Miniconda have only one built-in
# python executable, and it can be Python3 or 2 depending on which installation package is used
#
# So we want to have an Python3 alias here in case it's referred to
try {
  $PYTHON = (Get-Command python).Source
} catch {
  $PYTHON = ""
}

If ("$PYTHON" -eq "") {
  Write-Output "Found no Python in $Env:PATH. Double check that Miniconda3 is setup correctly in the AMI"
}
Else {
  Write-Output "Found Python command at $PYTHON"
}

try {
  $PYTHON3 = (Get-Command python3).Source
} catch {
  $PYTHON3 = ""
}

If ("$PYTHON3" -eq "") {
  Write-Output "Found no Python 3 in $Env:PATH. This is expected for Miniconda3, and the command will be an alias to Python"
}
Else {
  Write-Output "Found Python 3 command at $PYTHON3"
}

If (("$PYTHON3" -eq "") -and ("$PYTHON" -ne "")) {
  Add-Content "$PS_PROFILE" "Set-Alias -Name python3 -Value $PYTHON"
}
