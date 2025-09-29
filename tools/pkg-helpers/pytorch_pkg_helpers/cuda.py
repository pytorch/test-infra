import sys
from typing import List

from .utils import transform_cuversion


WINDOWS_PATH_PREFIX = "C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v"


def get_cuda_arch_list(sanitized_version: str, package_type: str = "", platform: str = "") -> str:
    # Fallback for other versions - maintain backward compatibility
    base_arch_list = (
        "5.0;6.0;7.0;7.5;8.0;8.6;9.0"
    )
    # removing sm_50-sm_60 as these architectures are deprecated in CUDA 12.8/9 and will be removed in future releases
    # however we would like to keep sm_70 architecture see: https://github.com/pytorch/pytorch/issues/157517
    if sanitized_version == "12.8":
        return "7.0;7.5;8.0;8.6;9.0;10.0;12.0"
    elif sanitized_version == "13.0":
        arch_list = "7.5;8.0;8.6;9.0;10.0;12.0+PTX"
        # Add sm_110 for aarch64
        if "aarch64" in platform:
            arch_list = "8.0;9.0;10.0;11.0;12.0+PTX"
        return arch_list
    return base_arch_list


def get_cuda_variables(
    package_type: str, platform: str, gpu_arch_version: str
) -> List[str]:
    version_suffix = ""
    pytorch_version_suffix = ""
    wheel_dir = ""
    if package_type == "wheel" and platform != "darwin" and platform != "linux-aarch64":
        version_suffix = f"+{gpu_arch_version}"
        pytorch_version_suffix = f"+{gpu_arch_version}"
        wheel_dir = f"{gpu_arch_version}/"

    ret = [
        f"export VERSION_SUFFIX='{version_suffix}'",
        f"export PYTORCH_VERSION_SUFFIX='{pytorch_version_suffix}'",
        f"export WHEEL_DIR='{wheel_dir}'",
    ]

    cuda_home = ""
    sanitized_version = transform_cuversion(gpu_arch_version)
    # CUDA
    if gpu_arch_version.startswith("cu"):
        if platform.startswith("linux"):
            cuda_home = f"/usr/local/cuda-{sanitized_version}"
        elif platform in ("win32", "cygwin"):
            cuda_home = f"{WINDOWS_PATH_PREFIX}{sanitized_version}"
        else:
            raise NotImplementedError(
                f"Unrecognized platform ({sys.platform}) "
                f"for gpu_arch_version ({gpu_arch_version})"
            )
        cuda_arch_list = get_cuda_arch_list(sanitized_version, platform)
        ret.extend(
            [
                f"export CUDA_HOME='{cuda_home}'",
                f"export CUDA_PATH='{cuda_home}'",
                f"export TORCH_CUDA_ARCH_LIST='{cuda_arch_list}'",
                # Double quotes needed here to expand PATH var
                f'export PATH="{cuda_home}/bin:${{PATH}}"',
                "export FORCE_CUDA=1",
            ]
        )
    # ROCM
    elif gpu_arch_version.startswith("rocm"):
        ret.extend(
            [
                "export FORCE_CUDA=1",
            ]
        )
    return ret
