param(
  [string] $cudaVersion = $env:CUDA_VERSION
)

function New-TemporaryDirectory() {
  New-TemporaryFile | ForEach-Object { Remove-Item $_; New-Item -ItemType Directory -Path $_ }
}

$windowsS3BaseUrl = "https://ossci-windows.s3.amazonaws.com"
$ProgressPreference = 'SilentlyContinue'

# installerArgs
$installerArgs = "nvcc_$cudaVersion cuobjdump_$cudaVersion nvprune_$cudaVersion nvprof_$cudaVersion cupti_$cudaVersion cublas_$cudaVersion cublas_dev_$cudaVersion cudart_$cudaVersion cufft_$cudaVersion cufft_dev_$cudaVersion curand_$cudaVersion curand_dev_$cudaVersion cusolver_$cudaVersion cusolver_dev_$cudaVersion cusparse_$cudaVersion cusparse_dev_$cudaVersion npp_$cudaVersion npp_dev_$cudaVersion nvrtc_$cudaVersion nvrtc_dev_$cudaVersion nvml_dev_$cudaVersion nvjpeg_$cudaVersion nvjpeg_dev_$cudaVersion"

# Switch statement for specfic CUDA versions
$cudnn_subfolder="cuda"
$cudnn_lib_folder="lib\x64"
$cudnn_subfolder="cudnn-windows-x86_64-8.3.2.44_cuda11.5-archive"
$toolkitInstaller = "cuda_11.3.0_465.89_win10.exe"

Switch ($cudaVersion) {
  "11.7" {
    $toolkitInstaller = "cuda_11.7.0_516.01_windows.exe"
    $cudnn_subfolder = "cudnn-windows-x86_64-8.5.0.96_cuda11-archive"
  }
  "11.8" {
    $toolkitInstaller = "cuda_11.8.0_522.06_windows.exe"
    $cudnn_subfolder = "cudnn-windows-x86_64-8.7.0.84_cuda11-archive"
    $installerArgs += " cuda_profiler_api_$cudaVersion"
  }
  "12.1" {
    $toolkitInstaller = "cuda_12.1.0_531.14_windows.exe"
    $cudnn_subfolder = "cudnn-windows-x86_64-8.8.1.3_cuda12-archive"
    $installerArgs += " cuda_profiler_api_$cudaVersion nvjitlink_$cudaVersion"
  }
}


$cudnnZip = "$cudnn_subfolder.zip"
$installerArgs = "$installerArgs thrust_$cudaVersion"
$cudnn_lib_folder="lib"

Write-Output "Downloading ZLIB DLL, $windowsS3BaseUrl/zlib123dllx64.zip"
$tmpZlibDll = New-TemporaryFile
Invoke-WebRequest -Uri "$windowsS3BaseUrl/zlib123dllx64.zip" -OutFile "$tmpZlibDll"
$tmpExtractedZlibDll = New-TemporaryDirectory
7z x "$tmpZlibDll" -o"$tmpExtractedZlibDll"
Get-ChildItem -Path $tmpExtractedZlibDll
if (-Not (Test-Path -Path "$tmpExtractedZlibDll\dll_x64\zlibwapi.dll" -PathType Leaf)) {
  Write-Error "zlib installation failed $tmpExtractedZlibDll\dll_x64\zlibwapi.dll"
  exit 1
}
Copy-Item -Force -Verbose -Recurse "$tmpExtractedZlibDll\dll_x64\zlibwapi.dll" "c:\windows\system32\"


function Install-CudaToolkit() {
  $expectedInstallLocation = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v$cudaVersion"
  if (Test-Path -Path "$expectedInstallLocation\bin\nvcc.exe" -PathType Leaf) {
    Write-Output "Existing cudatoolkit installation already found at '$expectedInstallLocation', continuing..."
    return
  }

  Write-Output "Downloading toolkit installer, $windowsS3BaseUrl/$toolkitInstaller"
  $tmpToolkitInstaller = New-TemporaryFile
  Invoke-WebRequest -Uri "$windowsS3BaseUrl/$toolkitInstaller" -OutFile "$tmpToolkitInstaller"
  $tmpExtractedInstaller = New-TemporaryDirectory
  7z x "$tmpToolkitInstaller" -o"$tmpExtractedInstaller"
  $cudaInstallLogs = New-TemporaryDirectory

  Write-Output "Running installer for CUDA v$cudaVersion..."
  $argsList = "-s $installerArgs -loglevel:6 -log:$cudaInstallLogs"
  Write-Output "setup.exe: $tmpExtractedInstaller\setup.exe"
  Write-Output "Args: $argsList"
  Start-Process -FilePath "$tmpExtractedInstaller\setup.exe" -ArgumentList "$argsList" -Wait -NoNewWindow -PassThru
  if (-Not (Test-Path -Path "$expectedInstallLocation\bin\nvcc.exe" -PathType Leaf)) {
    Write-Error "CUDA installation failed for CUDA version $cudaVersion, nvcc not found at $expectedInstallLocation\bin\nvcc.exe"
    Write-Error "==== LOG.RunDll32.exe.log ===="
    Get-Content -Path "$cudaInstallLogs\LOG.RunDll32.exe.log"
    Write-Error "==== Log.setup.exe.log ===="
    Get-Content -Path "$cudaInstallLogs\LOG.setup.exe.log"
    exit 1
  }


  Write-Output "Installing VS 2019 integration"
  Copy-Item -Force -Verbose -Recurse "$tmpExtractedInstaller\visual_studio_integration\CUDAVisualStudioIntegration\extras\visual_studio_integration\MSBuildExtensions\*.*" "$expectedInstallLocation\MSBuildExtensions"
}

function Install-Cudnn() {
  $expectedInstallLocation = "$env:ProgramFiles\NVIDIA GPU Computing Toolkit\CUDA\v$cudaVersion\"
  if (Test-Path -Path "$expectedInstallLocation\include\cudnn.h" -PathType Leaf) {
    Write-Output "Existing cudnn installation already found at '$expectedInstallLocation', continuing..."
    return
  }

  Write-Output "Downloading cudnnArchive, $windowsS3BaseUrl/$cudnnZip"
  $tmpCudnnInstall = New-TemporaryFile
  Invoke-WebRequest -Uri "$windowsS3BaseUrl/$cudnnZip" -OutFile "$tmpCudnnInstall"
  $tmpCudnnExtracted = New-TemporaryDirectory
  7z x "$tmpCudnnInstall" -o"$tmpCudnnExtracted"

  Write-Output "Copying cudnn to $expectedInstallLocation"

  Copy-Item -Force -Verbose -Recurse "$tmpCudnnExtracted\$cudnn_subfolder\bin\*" "$expectedInstallLocation\bin"
  # TODO: Remove when CUDA 11.7 is deprecated
  if ($cudaVersion -eq "11.7") {
    Copy-Item -Force -Verbose -Recurse "$tmpCudnnExtracted\$cudnn_subfolder\$cudnn_lib_folder\*" "$expectedInstallLocation\lib\x64"
  } else {
    Copy-Item -Force -Verbose -Recurse "$tmpCudnnExtracted\$cudnn_subfolder\$cudnn_lib_folder\x64\*" "$expectedInstallLocation\lib\x64"
  }
  Copy-Item -Force -Verbose -Recurse "$tmpCudnnExtracted\$cudnn_subfolder\include\*" "$expectedInstallLocation\include"

  if (-Not (Test-Path -Path "$expectedInstallLocation\include\cudnn.h" -PathType Leaf)) {
    Write-Error "cudnn installation failed for CUDA version $cudaVersion, cudnn.h not found at $expectedInstallLocation\include\cudnn.h"
    exit 1
  }
}

function Install-NvTools() {
  $nvToolsLocalPath = "C:\Program Files\NVIDIA Corporation\NvToolsExt"
  # Check if we actually need to do the install
  if (Test-Path -Path "$nvToolsLocalPath" -PathType Container) {
    Write-Output "Existing nvtools installation already found, continuing..."
    return
  }
  $nvToolsUrl = "https://ossci-windows.s3.amazonaws.com/NvToolsExt.7z"
  $tmpToolsDl = New-TemporaryFile
  Write-Output "Downloading NvTools, $nvToolsUrl"
  Invoke-WebRequest -Uri "$nvToolsUrl" -OutFile "$tmpToolsDl"
  $tmpExtractedNvTools = New-TemporaryDirectory
  7z x "$tmpToolsDl" -o"$tmpExtractedNvTools"

  Write-Output "Copying NvTools, '$tmpExtractedNvTools' -> '$nvToolsLocalPath'"
  New-Item -Path "$nvToolsLocalPath "-ItemType "directory" -Force
  Copy-Item -Recurse -Path "$tmpExtractedNvTools\*" -Destination "$nvToolsLocalPath"
}

Install-CudaToolkit
Install-Cudnn
Install-NvTools
# Clear out temp files
Remove-Item -Path "$env:TEMP\*" -Recurse -Force -ErrorAction SilentlyContinue
