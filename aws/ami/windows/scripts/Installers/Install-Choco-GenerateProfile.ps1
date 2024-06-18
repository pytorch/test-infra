$ErrorActionPreference = "Continue"
$VerbosePreference = "Continue"

$parentDir = "C:\Jenkins"
$condaInstallationDir = "$parentDir\Miniconda3"

# Install Chocolatey
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
$env:chocolateyUseWindowsCompression = 'true'
Invoke-WebRequest https://community.chocolatey.org/install.ps1 -UseBasicParsing | Invoke-Expression

# Add Chocolatey to powershell profile
$ChocoProfileValue = @'
$ChocolateyProfile = "$env:ChocolateyInstall\helpers\chocolateyProfile.psm1"
if (Test-Path($ChocolateyProfile)) {
  Import-Module "$ChocolateyProfile"
}
Remove-Item Alias:curl
Remove-Item Alias:wget
refreshenv
'@

# https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_profiles
$PS_PROFILE = "$PsHome\Microsoft.PowerShell_profile.ps1"

# Write it to the $profile location
Set-Content -Path $PS_PROFILE -Value $ChocoProfileValue -Force

$PYTHON_PATH = '$Env:PATH += ' + "';$condaInstallationDir'"
# Add conda path to the powershell profile to make its commands, i.e. python, available when logging
# in to Windows runners or when the CI uses powershell
Add-Content "$PS_PROFILE" "$PYTHON_PATH"

# Source it
. $PS_PROFILE

$condaHook = "$condaInstallationDir\shell\condabin\conda-hook.ps1"
if (-Not (Test-Path -Path $condaHook -PathType Leaf)) {
  Write-Error "Miniconda installation failed, no hook found at $condaHook"
  exit 1
}

# Load conda into powershell
& $condaHook

# According to https://docs.conda.io/en/latest/miniconda.html, Miniconda have only one built-in
# python executable, and it can be Python3 or 2 depending on which installation package is used
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
  # Setup an alias from Python3 to Python when only the latter exists in Miniconda3
  Add-Content "$PS_PROFILE" "Set-Alias -Name python3 -Value $PYTHON"
}
