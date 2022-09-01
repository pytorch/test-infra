#!/usr/bin/env python3

"""Generates a matrix to be utilized through github actions

Will output a condensed version of the matrix if on a pull request that only
includes the latest version of python we support built on three different
architectures:
    * CPU
    * Latest CUDA
    * Latest ROCM
"""


import argparse
import os
import json

from typing import Dict, List, Tuple, Optional

FULL_PYTHON_VERSIONS = ["3.7", "3.8", "3.9", "3.10"]
ROCM_ARCHES = ["5.1.1", "5.2"]
CUDA_ACRHES_DICT = {
    "nightly": ["10.2", "11.3", "11.6", "11.7"],
    "test": ["10.2", "11.3", "11.6"],
    "release": ["10.2", "11.3", "11.6"]
}
PRE_CXX11_ABI = "pre-cxx11"
CXX11_ABI = "cxx11-abi"
RELEASE = "release"
DEBUG = "debug"

# By default use Nightly for CUDA arches
CUDA_ARCHES = CUDA_ACRHES_DICT["nightly"]

LINUX_GPU_RUNNER="ubuntu-20.04-m60"
LINUX_CPU_RUNNER="ubuntu-20.04"
WIN_GPU_RUNNER="windows-2019-m60"
WIN_CPU_RUNNER="windows-2019"
MACOS_M1_RUNNER="macos-m1-12"


def arch_type(arch_version: str) -> str:
    if arch_version in CUDA_ARCHES:
        return "cuda"
    elif arch_version in ROCM_ARCHES:
        return "rocm"
    else:  # arch_version should always be "cpu" in this case
        return "cpu"

def validation_runner(arch_type: str, os: str) -> str:
    if os == "linux":
        if arch_type == "cuda":
            return LINUX_GPU_RUNNER
        else:
            return LINUX_CPU_RUNNER
    elif os == "windows":
        if arch_type == "cuda":
            return WIN_GPU_RUNNER
        else:
            return WIN_CPU_RUNNER
    elif os == "macos-arm64":
        return MACOS_M1_RUNNER
    else: # default to linux cpu runner
        return LINUX_CPU_RUNNER

WHEEL_CONTAINER_IMAGES = {
    **{
        gpu_arch: f"pytorch/manylinux-builder:cuda{gpu_arch}"
        for gpu_arch in CUDA_ARCHES
    },
    **{
        gpu_arch: f"pytorch/manylinux-builder:rocm{gpu_arch}"
        for gpu_arch in ROCM_ARCHES
    },
    "cpu": "pytorch/manylinux-builder:cpu",
}

CONDA_CONTAINER_IMAGES = {
    **{gpu_arch: f"pytorch/conda-builder:cuda{gpu_arch}" for gpu_arch in CUDA_ARCHES},
    "cpu": "pytorch/conda-builder:cpu",
}



LIBTORCH_CONTAINER_IMAGES: Dict[Tuple[str, str], str] = {
    **{
        (gpu_arch, PRE_CXX11_ABI): f"pytorch/manylinux-builder:cuda{gpu_arch}"
        for gpu_arch in CUDA_ARCHES
    },
    **{
        (gpu_arch, CXX11_ABI): f"pytorch/libtorch-cxx11-builder:cuda{gpu_arch}"
        for gpu_arch in CUDA_ARCHES
    },
    **{
        (gpu_arch, PRE_CXX11_ABI): f"pytorch/manylinux-builder:rocm{gpu_arch}"
        for gpu_arch in ROCM_ARCHES
    },
    **{
        (gpu_arch, CXX11_ABI): f"pytorch/libtorch-cxx11-builder:rocm{gpu_arch}"
        for gpu_arch in ROCM_ARCHES
    },
    ("cpu", PRE_CXX11_ABI): "pytorch/manylinux-builder:cpu",
    ("cpu", CXX11_ABI): "pytorch/libtorch-cxx11-builder:cpu",
}

FULL_PYTHON_VERSIONS = ["3.7", "3.8", "3.9", "3.10"]


def translate_desired_cuda(gpu_arch_type: str, gpu_arch_version: str) -> str:
    return {
        "cpu": "cpu",
        "cuda": f"cu{gpu_arch_version.replace('.', '')}",
        "rocm": f"rocm{gpu_arch_version}",
    }.get(gpu_arch_type, gpu_arch_version)


def list_without(in_list: List[str], without: List[str]) -> List[str]:
    return [item for item in in_list if item not in without]


def generate_conda_matrix(os: str, channel: str) -> List[Dict[str, str]]:
    ret: List[Dict[str, str]] = []
    arches = ["cpu"]
    python_versions = FULL_PYTHON_VERSIONS
    if os == "linux":
        arches += CUDA_ARCHES
    elif os == "windows":
        # We don't build CUDA 10.2 for window see https://github.com/pytorch/pytorch/issues/65648
        arches += list_without(CUDA_ARCHES, ["10.2"])
    elif os == "macos-arm64":
        python_versions = list_without(python_versions, ["3.7"])
    for python_version in python_versions:
        # We don't currently build conda packages for rocm
        for arch_version in arches:
            gpu_arch_type = arch_type(arch_version)
            gpu_arch_version = "" if arch_version == "cpu" else arch_version
            ret.append(
                {
                    "python_version": python_version,
                    "gpu_arch_type": gpu_arch_type,
                    "gpu_arch_version": gpu_arch_version,
                    "desired_cuda": translate_desired_cuda(
                        gpu_arch_type, gpu_arch_version
                    ),
                    "container_image": CONDA_CONTAINER_IMAGES[arch_version],
                    "package_type": "conda",
                    "build_name": f"conda-py{python_version}-{gpu_arch_type}{gpu_arch_version}".replace(
                        ".", "_"
                    ),
                    "validation_runner": validation_runner(gpu_arch_type, os),
                    "channel": channel,
                }
            )
    return ret


def generate_libtorch_matrix(
    os: str,
    channel: str,
    abi_versions: Optional[List[str]] = None,
    arches: Optional[List[str]] = None,
    libtorch_variants: Optional[List[str]] = None,
) -> List[Dict[str, str]]:

    ret: List[Dict[str, str]] = []

    if os == "macos-arm64" or os == "macos":
        return ret

    if arches is None:
        arches = ["cpu"]
        if os == "linux":
            arches += CUDA_ARCHES
            arches += ROCM_ARCHES
        elif os == "windows":
            # We don't build CUDA 10.2 for window see https://github.com/pytorch/pytorch/issues/65648
            arches += list_without(CUDA_ARCHES, ["10.2"])

    if abi_versions is None:
        if os == "windows":
            abi_versions = [RELEASE, DEBUG]
        elif os == "linux":
            abi_versions = [PRE_CXX11_ABI, CXX11_ABI]

    if libtorch_variants is None:
        libtorch_variants = [
            "shared-with-deps",
            "shared-without-deps",
            "static-with-deps",
            "static-without-deps",
        ]

    for abi_version in abi_versions:
        for arch_version in arches:
            for libtorch_variant in libtorch_variants:
                # one of the values in the following list must be exactly
                # CXX11_ABI, but the precise value of the other one doesn't
                # matter
                gpu_arch_type = arch_type(arch_version)
                gpu_arch_version = "" if arch_version == "cpu" else arch_version
                # ROCm builds without-deps failed even in ROCm runners; skip for now
                if gpu_arch_type == "rocm" and "without-deps" in libtorch_variant:
                    continue
                ret.append(
                    {
                        "gpu_arch_type": gpu_arch_type,
                        "gpu_arch_version": gpu_arch_version,
                        "desired_cuda": translate_desired_cuda(
                            gpu_arch_type, gpu_arch_version
                        ),
                        "libtorch_variant": libtorch_variant,
                        "libtorch_config": abi_version if os == "windows" else "",
                        "devtoolset": abi_version if os != "windows" else "",
                        "container_image": LIBTORCH_CONTAINER_IMAGES[
                            (arch_version, abi_version)
                        ]
                        if os != "windows"
                        else "",
                        "package_type": "libtorch",
                        "build_name": f"libtorch-{gpu_arch_type}{gpu_arch_version}-{libtorch_variant}-{abi_version}".replace(
                            ".", "_"
                        ),
                        "validation_runner": validation_runner(gpu_arch_type, os),
                        "channel": channel
                    }
                )
    return ret


def generate_wheels_matrix(
    os: str,
    channel: str,
    arches: Optional[List[str]] = None,
    python_versions: Optional[List[str]] = None,
) -> List[Dict[str, str]]:
    package_type = "wheel"
    if os == "linux":
        # NOTE: We only build manywheel packages for linux
        package_type = "manywheel"

    if python_versions is None:
        # Define default python version
        python_versions = list(FULL_PYTHON_VERSIONS)
        if os == "macos-arm64":
            python_versions = list_without(python_versions, ["3.7"])

    if arches is None:
        # Define default compute archivectures
        arches = ["cpu"]
        if os == "linux":
            arches += CUDA_ARCHES + ROCM_ARCHES
        elif os == "windows":
            # We don't build CUDA 10.2 for window see https://github.com/pytorch/pytorch/issues/65648
            arches += list_without(CUDA_ARCHES, ["10.2"])

    ret: List[Dict[str, str]] = []
    for python_version in python_versions:
        for arch_version in arches:
            gpu_arch_type = arch_type(arch_version)
            gpu_arch_version = "" if arch_version == "cpu" else arch_version
            # Skip rocm 3.11 binaries for now as the docker image are not correct
            if python_version == "3.11" and gpu_arch_type == "rocm":
                continue
            ret.append(
                {
                    "python_version": python_version,
                    "gpu_arch_type": gpu_arch_type,
                    "gpu_arch_version": gpu_arch_version,
                    "desired_cuda": translate_desired_cuda(
                        gpu_arch_type, gpu_arch_version
                    ),
                    "container_image": WHEEL_CONTAINER_IMAGES[arch_version],
                    "package_type": package_type,
                    "build_name": f"{package_type}-py{python_version}-{gpu_arch_type}{gpu_arch_version}".replace(
                        ".", "_"
                    ),
                    "validation_runner": validation_runner(gpu_arch_type, os),
                    "channel": channel,
                }
            )
    return ret


GENERATING_FUNCTIONS_BY_PACKAGE_TYPE = {
    "wheel": generate_wheels_matrix,
    "conda": generate_conda_matrix,
    "libtorch": generate_libtorch_matrix,
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--package-type",
        help="Package type to lookup for",
        type=str,
        choices=["wheel", "conda", "libtorch"],
        default=os.getenv("PACKAGE_TYPE", "wheel"),
    )
    parser.add_argument(
        "--operating-system",
        help="Operating system to generate for",
        type=str,
        default=os.getenv("OS", "linux"),
    )
    parser.add_argument(
        "--channel",
        help="Channel to use, default nightly",
        type=str,
        choices=["nightly", "test", "release", "all"],
        default=os.getenv("CHANNEL", "nightly"),
    )
    options = parser.parse_args()
    includes = []

    if options.channel == "all":
        for channel in CUDA_ACRHES_DICT:
            CUDA_ARCHES = CUDA_ACRHES_DICT[channel]
            includes.extend(GENERATING_FUNCTIONS_BY_PACKAGE_TYPE[options.package_type](options.operating_system, channel))
    else:
        CUDA_ARCHES = CUDA_ACRHES_DICT[options.channel]
        includes = GENERATING_FUNCTIONS_BY_PACKAGE_TYPE[options.package_type](options.operating_system, options.channel)

    print(json.dumps({"include": includes}))

if __name__ == "__main__":
    main()
