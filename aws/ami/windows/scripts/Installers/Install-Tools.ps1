Write-Host "Installing additional development tools"
choco install jq awscli archiver 7zip.install curl vswhere -y
choco install git --params "/GitAndUnixToolsOnPath" -y
choco install windows-sdk-10-version-2004-all --version=10.0.19041.0 -y

# cmake: ADD_CMAKE_TO_PATH=System is required for MKL detection during PyTorch builds.
# Without it, CMake's FindMKL module can't locate MKL libraries and the CUDA build fails
# with unresolved LAPACK/BLAS symbols from MAGMA. See pytorch/pytorch#178963.
choco install cmake --installargs 'ADD_CMAKE_TO_PATH=System' --apply-install-arguments-to-dependencies --version=3.27.9 -y

# handle (Sysinternals): used by setup-win/teardown-win to diagnose file locks.
# Pre-installing avoids runtime dependency on Chocolatey CDN, which has had repeated
# outages causing false CI failures. See pytorch-gha-infra#1044, #1049, #1078.
choco install handle -y

refreshenv

Get-Command curl
Get-Command aws
Get-Command 7z
Get-Command jq
Get-Command vswhere
Get-Command bash.exe
Get-Command cmake
Get-Command handle
Test-Path "C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\gflags.exe"
