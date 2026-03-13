#!/bin/bash
# Adapted from PyTorch CI: .ci/docker/common/install_cuda.sh
# Inlines NCCL and cuSPARSELt installation (upstream uses separate scripts + pin files).
#
# Installs all three CUDA versions (12.8, 12.9, 13.0) into separate prefixes:
#   /usr/local/cuda-12.8, /usr/local/cuda-12.9, /usr/local/cuda-13.0
# with /usr/local/cuda symlinked to /usr/local/cuda-13.0 as the default.
set -ex

NCCL_VERSION="${NCCL_VERSION:-v2.28.9-1}"
NVSHMEM_VERSION="${NVSHMEM_VERSION:-3.4.5}"

# Detect architecture: x86_64 or sbsa (aarch64)
ARCH_PATH=""
targetarch=${TARGETARCH:-$(uname -m)}
if [ "${targetarch}" = "amd64" ] || [ "${targetarch}" = "x86_64" ]; then
  ARCH_PATH="x86_64"
else
  ARCH_PATH="sbsa"
fi

###############################################################################
# Core installers
###############################################################################

install_cuda() {
  local version=$1
  local runfile=$2
  local prefix=$3
  local major_minor=${version%.*}

  rm -rf /usr/local/cuda-"${major_minor}" /usr/local/cuda
  if [ "${ARCH_PATH}" = "sbsa" ]; then
    runfile="${runfile}_sbsa"
  fi
  runfile="${runfile}.run"
  wget -q "https://developer.download.nvidia.com/compute/cuda/${version}/local_installers/${runfile}" -O "${runfile}"
  chmod +x "${runfile}"
  ./"${runfile}" --toolkit --silent
  rm -f "${runfile}"
  # The runfile installs to /usr/local/cuda-MAJOR.MINOR by default.
  # Move to the target prefix only if it differs from the default path.
  rm -f /usr/local/cuda
  if [ "/usr/local/cuda-${major_minor}" != "${prefix}" ]; then
    mv /usr/local/cuda-"${major_minor}" "${prefix}"
  fi
}

install_cudnn() {
  local cuda_major_version=$1
  local cudnn_version=$2
  local prefix=$3

  mkdir tmp_cudnn && cd tmp_cudnn
  # cuDNN license: https://developer.nvidia.com/cudnn/license_agreement
  local filepath="cudnn-linux-${ARCH_PATH}-${cudnn_version}_cuda${cuda_major_version}-archive"
  wget -q "https://developer.download.nvidia.com/compute/cudnn/redist/cudnn/linux-${ARCH_PATH}/${filepath}.tar.xz"
  tar xf "${filepath}.tar.xz"
  cp -a "${filepath}/include/"* "${prefix}/include/"
  cp -a "${filepath}/lib/"* "${prefix}/lib64/"
  cd ..
  rm -rf tmp_cudnn
}

install_nvshmem() {
  local cuda_major_version=$1
  local nvshmem_version=$2
  local prefix=$3

  mkdir -p tmp_nvshmem && cd tmp_nvshmem
  # nvSHMEM license: https://docs.nvidia.com/nvshmem/api/sla.html
  local filename="libnvshmem-linux-${ARCH_PATH}-${nvshmem_version}_cuda${cuda_major_version}-archive"
  wget -q "https://developer.download.nvidia.com/compute/nvshmem/redist/libnvshmem/linux-${ARCH_PATH}/${filename}.tar.xz"
  tar xf "${filename}.tar.xz"
  cp -a "${filename}/include/"* "${prefix}/include/"
  cp -a "${filename}/lib/"* "${prefix}/lib64/"
  cd ..
  rm -rf tmp_nvshmem
}

install_nccl() {
  local prefix=$1

  # Build NCCL from source
  # NCCL license: https://docs.nvidia.com/deeplearning/nccl/#licenses
  git clone -b "${NCCL_VERSION}" --depth 1 https://github.com/NVIDIA/nccl.git
  pushd nccl
  make -j CUDA_HOME="${prefix}" src.build
  cp -a build/include/* "${prefix}/include/"
  cp -a build/lib/* "${prefix}/lib64/"
  popd
  rm -rf nccl
  ldconfig
}

install_cusparselt() {
  local cuda_version=$1
  local prefix=$2
  local cusparselt_name

  mkdir tmp_cusparselt && cd tmp_cusparselt
  # cuSPARSELt license: https://docs.nvidia.com/cuda/cusparselt/license.html
  if [[ "${cuda_version}" == 13.* ]]; then
    cusparselt_name="libcusparse_lt-linux-${ARCH_PATH}-0.8.0.4_cuda13-archive"
  elif [[ "${cuda_version}" == 12.[5-9]* ]]; then
    cusparselt_name="libcusparse_lt-linux-${ARCH_PATH}-0.7.1.0-archive"
  else
    echo "Unknown cuSPARSELt version for CUDA ${cuda_version}"
    cd .. && rm -rf tmp_cusparselt
    return 1
  fi

  curl --retry 3 -OLs "https://developer.download.nvidia.com/compute/cusparselt/redist/libcusparse_lt/linux-${ARCH_PATH}/${cusparselt_name}.tar.xz"
  tar xf "${cusparselt_name}.tar.xz"
  cp -a "${cusparselt_name}/include/"* "${prefix}/include/"
  cp -a "${cusparselt_name}/lib/"* "${prefix}/lib64/"
  cd ..
  rm -rf tmp_cusparselt
  ldconfig
}

###############################################################################
# Per-version installers
###############################################################################

install_128() {
  local prefix=/usr/local/cuda-12.8
  echo "Installing CUDA 12.8.1 + cuDNN 9.19.0.56 + nvSHMEM + NCCL + cuSPARSELt 0.7.1"
  install_cuda 12.8.1 cuda_12.8.1_570.124.06_linux "${prefix}"
  install_cudnn 12 9.19.0.56 "${prefix}"
  install_nvshmem 12 "${NVSHMEM_VERSION}" "${prefix}"
  install_nccl "${prefix}"
  install_cusparselt 12.8 "${prefix}"
  ldconfig
}

install_129() {
  local prefix=/usr/local/cuda-12.9
  echo "Installing CUDA 12.9.1 + cuDNN 9.17.1.4 + nvSHMEM + NCCL + cuSPARSELt 0.7.1"
  install_cuda 12.9.1 cuda_12.9.1_575.57.08_linux "${prefix}"
  install_cudnn 12 9.17.1.4 "${prefix}"
  install_nvshmem 12 "${NVSHMEM_VERSION}" "${prefix}"
  install_nccl "${prefix}"
  install_cusparselt 12.9 "${prefix}"
  ldconfig
}

install_130() {
  local prefix=/usr/local/cuda-13.0
  echo "Installing CUDA 13.0.2 + cuDNN 9.19.0.56 + nvSHMEM + NCCL + cuSPARSELt 0.8.0"
  install_cuda 13.0.2 cuda_13.0.2_580.95.05_linux "${prefix}"
  install_cudnn 13 9.19.0.56 "${prefix}"
  install_nvshmem 13 "${NVSHMEM_VERSION}" "${prefix}"
  install_nccl "${prefix}"
  install_cusparselt 13.0 "${prefix}"
  ldconfig
}

###############################################################################
# Install all versions and set default symlink
###############################################################################

install_128
install_129
install_130
ln -sf /usr/local/cuda-13.0 /usr/local/cuda
ldconfig
