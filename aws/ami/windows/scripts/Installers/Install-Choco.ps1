$ErrorActionPreference = "Continue"
$VerbosePreference = "Continue"

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
# Write it to the $profile location
Set-Content -Path "$PsHome\Microsoft.PowerShell_profile.ps1" -Value $ChocoProfileValue -Force
# Source it
. "$PsHome\Microsoft.PowerShell_profile.ps1"
