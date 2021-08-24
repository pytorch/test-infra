param(
  [string] $cudaVersion = $env:CUDA_VERSION
)

$windowsS3BaseUrl = "https://ossci-windows.s3.amazonaws.com"

# Switch statement for specfic CUDA versions
Switch ($cudaVersion) {
  "10.2" {
    $toolkitInstaller = "cuda_10.2.89_441.22_win10.exe"
    $cudnnZip = "cudnn-10.2-windows10-x64-v7.6.5.32.zip"
  }
}

Switch -Wildcard ($cudaVersion) {
  "10*" {
    $installerArgs = "nvcc_$cudaVersion cuobjdump_$cudaVersion nvprune_$cudaVersion cupti_$cudaVersion cublas_$cudaVersion cublas_dev_$cudaVersion cudart_$cudaVersion cufft_$cudaVersion cufft_dev_$cudaVersion curand_$cudaVersion curand_dev_$cudaVersion cusolver_$cudaVersion cusolver_dev_$cudaVersion cusparse_$cudaVersion cusparse_dev_$cudaVersion nvgraph_$cudaVersion nvgraph_dev_$cudaVersion npp_$cudaVersion npp_dev_$cudaVersion nvrtc_$cudaVersion nvrtc_dev_$cudaVersion nvml_dev_$cudaVersion"
  }
}

function Install-CudaToolkit() {
  Write-Output "Downloading toolkit installer, $windowsS3BaseUrl/$toolkitInstaller"
  $tmpToolkitInstaller = New-TemporaryFile
  Invoke-WebRequest -Uri "$windowsS3BaseUrl/$toolkitInstaller" -OutFile "$tmpToolkitInstaller"
  $tmpExtractedInstaller = New-TemporaryFile | ForEach-Object { Remove-Item $_; New-Item -ItemType Directory -Path $_ }
  7z x "$toolkitInstaller" -o "$tmpExtractedInstaller"
  $cudaInstallLogs = New-TemporaryFile | ForEach-Object { Remove-Item $_; New-Item -ItemType Directory -Path $_ }

  Start-Process -Wait "$tmpExtractedInstaller\setup.exe" -s "$installerArgs" -loglevel:6 -log:"$cudaInstallLogs"
  $expectedInstallLocation = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v$cudaVersion"
  if (-Not (Test-Path -Path "$expectedInstallLocation\bin\nvcc.exe" -PathType Leaf)) {
    Write-Error "CUDA $cudaVersion installation failed, nvcc not found at $expectedInstallLocation\bin\nvcc.exe"
    Get-Content -Path "$cudaInstallLogs\LOG.RunDll32.exe.log"
    Get-Content -Path "$cudaInstallLogs\LOG.setup.exe.log"
    exit 1
  }
}

function Install-Cudnn() {

}

function Install-NvTools() {
  $nvToolsLocalPath = "C:\Program Files\NVIDIA Corporation\NvToolsExt"
  # Check if we actually need to do the install
  if (Test-Path -Path "$nvToolsLocalPath\bin\x64\nvToolsExt64_1.dll" -PathType Leaf) {
    return
  }
  $nvToolsUrl = "https://ossci-windows.s3.amazonaws.com/NvToolsExt.7z"
  $tmpToolsDl = New-TemporaryFile
  Write-Output "Downloading NvTools, $nvToolsUrl"
  Invoke-WebRequest -Uri "$nvToolsUrl" -OutFile "$tmpToolsDl"
  $tmpExtractedNvTools = New-TemporaryFile | ForEach-Object { Remove-Item $_; New-Item -ItemType Directory -Path $_ }
  7z x "$tmpToolsDl" -o "$tmpExtractedNvTools"

  Write-Output "Copying NvTools, '$tmpExtractedNvTools' -> '$nvToolsLocalPath'"
  New-Item -Path "$nvToolsLocalPath "-ItemType "directory" -Force
  Copy-Item -Recurse -Path "$tmpExtractedNvTools\*" -Destination "$nvToolsLocalPath"
}

# TODO:
# - install vs integration
# - install cudnn


# Write-Output "Downloading cudnn archive, $windowsS3BaseUrl/$cudnnZip"
# $tmpCudnnZip = New-TemporaryFile
# Invoke-WebRequest -Uri $windowsS3BaseUrl/$cudnnZip -OutFile $tmpCudnnZip
