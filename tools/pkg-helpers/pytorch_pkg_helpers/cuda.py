import sys

from typing import List

from .utils import transform_cuversion


def get_cuda_arch_list(sanitized_version: str) -> str:
    if float(sanitized_version) > 11.3:
        return "3.5;5.0+PTX;6.0;7.0;7.5;8.0;8.6"
    else:  # mainly for cuda 10.2
        return "3.5;5.0+PTX;6.0;7.0;7.5"


def get_cuda_variables(
    package_type: str, platform: str, gpu_arch_version: str
) -> List[str]:
    version_suffix = ""
    pytorch_version_suffix = ""
    wheel_dir = ""
    if package_type == "wheel" and platform != "darwin":
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
            cuda_home = f"C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v{sanitized_version}"
        else:
            raise NotImplementedError(
                f"Unrecognized platform ({sys.platform}) for gpu_arch_version ({gpu_arch_version})"
            )
        ret.extend(
            [
                f"export CUDA_HOME='{cuda_home}'",
                f"export TORCH_CUDA_ARCH_LIST='{get_cuda_arch_list(sanitized_version)}'",
                # Double quotes needed here to expand PATH var
                f'export PATH="{cuda_home}/bin;${{PATH}}"',
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
