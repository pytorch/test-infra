import re

from typing import List

from .utils import transform_cuversion


def normalize_gpu_arch_version(gpu_arch_version: str):
    ver_one = gpu_arch_version
    ver_two = gpu_arch_version
    if gpu_arch_version != "cpu":
        ver_one = gpu_arch_version.replace("cu", "cuda")
        ver_two = (gpu_arch_version[:-1] + "." + gpu_arch_version[-1]).replace(
            "cu", "cuda"
        )
    return ver_one, ver_two


def get_conda_version_variables(
    conda_search: str, gpu_arch_version: str, python_version: str, pytorch_version: str
) -> List[str]:
    ver_one, ver_two = normalize_gpu_arch_version(gpu_arch_version)
    if pytorch_version == "":
        for pkg in reversed(conda_search["pytorch"]):
            if (
                any(
                    [
                        pkg["platform"] == "darwin",
                        ver_one in pkg["fn"],
                        ver_two in pkg["fn"],
                    ]
                )
                # matches the python version we're looking for
                and "py" + python_version in pkg["fn"]
            ):
                pytorch_version = re.sub(r"\\+.*$", "", pkg["version"])
                break
    return [
        f"export PYTORCH_VERSION='{pytorch_version}'",
        f"export CONDA_PYTORCH_BUILD_CONSTRAINT='- pytorch=={pytorch_version}'",
        f"export CONDA_PYTORCH_CONSTRAINT='- pytorch=={pytorch_version}'",
    ]


def get_conda_cuda_variables(platform: str, gpu_arch_version: str) -> List[str]:
    conda_build_variant = "cpu"
    cmake_use_cuda = "0"
    conda_cuda_toolkit_constraint = ""
    sanitized_version = transform_cuversion(gpu_arch_version)
    if sanitized_version != "cpu":
        conda_build_variant = "cuda"
        cmake_use_cuda = "1"
        if float(sanitized_version) >= 11.6:
            conda_cuda_toolkit_constraint = f"- pytorch-cuda={sanitized_version} # [not osx]"
        elif float(sanitized_version) == 11.3:
            conda_cuda_toolkit_constraint = "- cudatoolkit >=11.3,<11.4 # [not osx]"
        elif float(sanitized_version) == 10.2:
            conda_cuda_toolkit_constraint = "- cudatoolkit >=10.2,<10.3 # [not osx]"
        else:
            conda_cuda_toolkit_constraint = f"cudatoolkit={sanitized_version}"
    return [
        f"export CONDA_BUILD_VARIANT='{conda_build_variant}'",
        f"export CMAKE_USE_CUDA='{cmake_use_cuda}'",
        f"export CONDA_CUDATOOLKIT_CONSTRAINT='{conda_cuda_toolkit_constraint}'",
        f"export CUDATOOLKIT_CHANNEL=nvidia",
    ]


def get_conda_variables(
    conda_search: str,
    platform: str,
    gpu_arch_version: str,
    python_version: str,
    pytorch_version: str,
) -> List[str]:
    return get_conda_version_variables(
        conda_search, gpu_arch_version, python_version, pytorch_version
    ) + get_conda_cuda_variables(platform, gpu_arch_version)
