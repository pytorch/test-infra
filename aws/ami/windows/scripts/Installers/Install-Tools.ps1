Write-Host "Installing additional development tools"
choco install jq awscli archiver 7zip.install curl vswhere -y
choco install git --params "/GitAndUnixToolsOnPath" -y

refreshenv

Get-Command curl
Get-Command aws
Get-Command 7z
Get-Command jq
Get-Command vswhere
Get-Command bash.exe
Test-Path "C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\gflags.exe"
