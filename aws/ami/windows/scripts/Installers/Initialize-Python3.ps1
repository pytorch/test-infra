# https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_profiles
$PS_PROFILE = "$PSHOME\Microsoft.PowerShell_profile.ps1"

$parentDir = "C:\Jenkins"
$installationDir = "$parentDir\Miniconda3"


$PYTHON_PATH = '$Env:PATH += ' + "';$installationDir'"

# Add conda path to the powershell profile to make its commands, i.e. python, available when logging
# in to Windows runners or when the CI uses powershell
Add-Content "$PS_PROFILE" "$PYTHON_PATH"

$Env:PATH += ";$installationDir"

# According to https://docs.conda.io/en/latest/miniconda.html, Miniconda have only one built-in
# python executable, and it can be Python3 or 2 depending on which installation package is used
# Please note
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
