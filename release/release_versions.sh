#!/usr/bin/env bash

# Make sure to update these versions when doing a release first
PYTORCH_VERSION=${PYTORCH_VERSION:-2.15.0}
# Comma-separated accelerator folders left out when torch, libtorch, torchvision
# and torchaudio are promoted to download.pytorch.org by
# release-download-pytorch-org.yml. 2.15.0: cu130 is skipped. Set it to an empty
# string to skip nothing. Remove it after 2.15.
RELEASE_PROMOTE_SKIP_TARGETS=${RELEASE_PROMOTE_SKIP_TARGETS-cu130}
TORCHVISION_VERSION=${TORCHVISION_VERSION:-0.29.2}
TORCHAUDIO_VERSION=${TORCHAUDIO_VERSION:-2.11.1}
TORCHCODEC_VERSION=${TORCHCODEC_VERSION:-0.17.0}
TORCHCOMMS_VERSION=${TORCHCOMMS_VERSION:-0.3.1}
TRITON_VERSION=${TRITON_VERSION:-3.9.0}
TORCHTEXT_VERSION=${TORCHTEXT_VERSION:-0.18.0}
TORCHREC_VERSION=${TORCHREC_VERSION:-1.9.2}
EXECUTORCH_VERSION=${EXECUTORCH_VERSION:-1.6.0}
TORCH_TENSORRT_VERSION=${TORCH_TENSORRT_VERSION:-2.14.0}
TORCH_TENSORRT_RTX_VERSION=${TORCH_TENSORRT_VERSION}
TORCH_TENSORRT_EXECUTORCH_RUNTIME_VERSION=${TORCH_TENSORRT_EXECUTORCH_RUNTIME_VERSION:-0.1.0}
TORCHAO_VERSION=${TORCHAO_VERSION:-0.18.0}
TORCHDATA_VERSION=${TORCHDATA_VERSION:-0.11.0}
TORCHTUNE_VERSION=${TORCHTUNE_VERSION:-0.2.1}
FBGEMM_GPU_VERSION=${FBGEMM_GPU_VERSION:-1.9.0}
FBGEMM_GPU_GENAI_VERSION=${FBGEMM_GPU_VERSION}
MSLK_VERSION=${MSLK_VERSION:-1.3.0}
FLASH_ATTN_3_VERSION=${FLASH_ATTN_3_VERSION:-3.0.1}

# release_package_vars <package>: what release-download-pytorch-org.yml needs to
# promote <package>. Sets, in the caller's scope:
#   version      name of the variable holding the version (torch is PYTORCH_VERSION)
#   packages     space-separated names one promotion of <package> copies; "triton" is
#                the whole triton family, which shares TRITON_VERSION. A name can be
#                a glob ("libtorch-*"), so split it with read -ra, not an unquoted
#                expansion
#   package_type the s3 channel directory: whl, or libtorch for the libtorch archives
#   skip_targets accelerator folders left out (RELEASE_PROMOTE_SKIP_TARGETS), for the
#                packages that have such folders
release_package_vars() {
    local pkg_name=$1
    skip_targets=""
    packages="${pkg_name}"
    package_type="whl"
    case "${pkg_name}" in
        torch)
            version="PYTORCH_VERSION"
            skip_targets="${RELEASE_PROMOTE_SKIP_TARGETS:-}"
            ;;
        libtorch)
            # Archives named libtorch-*-<version>*.zip under libtorch/<target>/
            version="PYTORCH_VERSION"
            packages="libtorch-*"
            package_type="libtorch"
            skip_targets="${RELEASE_PROMOTE_SKIP_TARGETS:-}"
            ;;
        torchvision | torchaudio)
            version="${pkg_name^^}_VERSION"
            skip_targets="${RELEASE_PROMOTE_SKIP_TARGETS:-}"
            ;;
        triton)
            version="TRITON_VERSION"
            packages="triton triton_rocm triton_xpu"
            ;;
        *)
            version="${pkg_name^^}_VERSION"
            ;;
    esac
}
