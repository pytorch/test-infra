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
