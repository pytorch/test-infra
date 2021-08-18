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

Write-Output "Downloading toolkit installer, $windowsS3BaseUrl/$toolkitInstaller"
$tmpToolkitInstaller = New-TemporaryFile
Invoke-WebRequest -Uri "$windowsS3BaseUrl/$toolkitInstaller" -OutFile "$tmpToolkitInstaller"
$tmpExtractedInstaller = New-TemporaryFile | ForEach-Object { Remove-Item $_; New-Item -ItemType Directory -Path $_ }
7z x "$toolkitInstaller" -o "$tmpExtractedInstaller"

Start-Process -Wait "$tmpExtractedInstaller\setup.exe" -s "$installerArgs"

# Write-Output "Downloading cudnn archive, $windowsS3BaseUrl/$cudnnZip"
# $tmpCudnnZip = New-TemporaryFile
# Invoke-WebRequest -Uri $windowsS3BaseUrl/$cudnnZip -OutFile $tmpCudnnZip
