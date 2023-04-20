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
import sys
import json

from typing import Dict, List, Tuple, Optional

mod = sys.modules[__name__]

PYTHON_ARCHES_DICT = {
    "nightly": ["3.8", "3.9", "3.10", "3.11"],
    "test": ["3.8", "3.9", "3.10", "3.11"],
    "release": ["3.8", "3.9", "3.10", "3.11"],
}
CUDA_ARCHES_DICT = {
    "nightly": ["11.7", "11.8"],
    "test": ["11.7", "11.8"],
    "release": ["11.7", "11.8"],
}
ROCM_ARCHES_DICT = {
    "nightly": ["5.3", "5.4.2"],
    "test": ["5.3", "5.4.2"],
    "release": ["5.3", "5.4.2"],
}

PACKAGE_TYPES = ["wheel", "conda", "libtorch"]
PRE_CXX11_ABI = "pre-cxx11"
CXX11_ABI = "cxx11-abi"
RELEASE = "release"
DEBUG = "debug"
NIGHTLY = "nightly"
TEST = "test"

CURRENT_CANDIDATE_VERSION = "2.0.1"
CURRENT_STABLE_VERSION = "2.0.0"
mod.CURRENT_VERSION = CURRENT_STABLE_VERSION

# By default use Nightly for CUDA arches
mod.CUDA_ARCHES = CUDA_ARCHES_DICT[NIGHTLY]
mod.ROCM_ARCHES = ROCM_ARCHES_DICT[NIGHTLY]
mod.PYTHON_ARCHES = PYTHON_ARCHES_DICT[NIGHTLY]

LINUX_GPU_RUNNER = "linux.g5.4xlarge.nvidia.gpu"
LINUX_CPU_RUNNER = "linux.2xlarge"
WIN_GPU_RUNNER = "windows.8xlarge.nvidia.gpu"
WIN_CPU_RUNNER = "windows.4xlarge"
MACOS_M1_RUNNER = "macos-m1-12"
MACOS_RUNNER = "macos-12"

PACKAGES_TO_INSTALL_WHL = "torch torchvision torchaudio"

PACKAGES_TO_INSTALL_CONDA = "pytorch torchvision torchaudio"
CONDA_INSTALL_BASE = f"conda install {PACKAGES_TO_INSTALL_CONDA}"
WHL_INSTALL_BASE = "pip3 install"
DOWNLOAD_URL_BASE = "https://download.pytorch.org"

ENABLE = "enable"
DISABLE = "disable"

def arch_type(arch_version: str) -> str:
    if arch_version in mod.CUDA_ARCHES:
        return "cuda"
    elif arch_version in mod.ROCM_ARCHES:
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
    elif os == "macos":
        return MACOS_RUNNER
    else: # default to linux cpu runner
        return LINUX_CPU_RUNNER

def initialize_globals(channel: str):
    if channel == TEST:
        mod.CURRENT_VERSION = CURRENT_CANDIDATE_VERSION
    else:
        mod.CURRENT_VERSION = CURRENT_STABLE_VERSION

    mod.CUDA_ARCHES = CUDA_ARCHES_DICT[channel]
    mod.ROCM_ARCHES = ROCM_ARCHES_DICT[channel]
    mod.PYTHON_ARCHES = PYTHON_ARCHES_DICT[channel]
    mod.WHEEL_CONTAINER_IMAGES = {
        **{
            gpu_arch: f"pytorch/manylinux-builder:cuda{gpu_arch}"
            for gpu_arch in mod.CUDA_ARCHES
        },
        **{
            gpu_arch: f"pytorch/manylinux-builder:rocm{gpu_arch}"
            for gpu_arch in mod.ROCM_ARCHES
        },
        "cpu": "pytorch/manylinux-builder:cpu",
    }
    mod.CONDA_CONTAINER_IMAGES = {
        **{gpu_arch: f"pytorch/conda-builder:cuda{gpu_arch}" for gpu_arch in mod.CUDA_ARCHES},
        "cpu": "pytorch/conda-builder:cpu",
    }
    mod.LIBTORCH_CONTAINER_IMAGES: Dict[Tuple[str, str], str] = {
        **{
            (gpu_arch, PRE_CXX11_ABI): f"pytorch/manylinux-builder:cuda{gpu_arch}"
            for gpu_arch in mod.CUDA_ARCHES
        },
        **{
            (gpu_arch, CXX11_ABI): f"pytorch/libtorch-cxx11-builder:cuda{gpu_arch}"
            for gpu_arch in mod.CUDA_ARCHES
        },
        **{
            (gpu_arch, PRE_CXX11_ABI): f"pytorch/manylinux-builder:rocm{gpu_arch}"
            for gpu_arch in mod.ROCM_ARCHES
        },
        **{
            (gpu_arch, CXX11_ABI): f"pytorch/libtorch-cxx11-builder:rocm{gpu_arch}"
            for gpu_arch in mod.ROCM_ARCHES
        },
        ("cpu", PRE_CXX11_ABI): "pytorch/manylinux-builder:cpu",
        ("cpu", CXX11_ABI): "pytorch/libtorch-cxx11-builder:cpu",
    }


def translate_desired_cuda(gpu_arch_type: str, gpu_arch_version: str) -> str:
    return {
        "cpu": "cpu",
        "cuda": f"cu{gpu_arch_version.replace('.', '')}",
        "rocm": f"rocm{gpu_arch_version}",
    }.get(gpu_arch_type, gpu_arch_version)


def list_without(in_list: List[str], without: List[str]) -> List[str]:
    return [item for item in in_list if item not in without]

def get_conda_install_command(channel: str, gpu_arch_type: str, arch_version: str, os: str) -> str:
    pytorch_channel = "pytorch" if channel == RELEASE else f"pytorch-{channel}"
    conda_channels = f"-c {pytorch_channel}"
    conda_package_type = ""
    if gpu_arch_type == "cuda":
        conda_package_type = f"pytorch-cuda={arch_version}"
        conda_channels = f"{conda_channels} -c nvidia"
    elif os not in ("macos", "macos-arm64"):
        conda_package_type = "cpuonly"
    else:
        return f"conda install {pytorch_channel}::{PACKAGES_TO_INSTALL_CONDA} {conda_channels}"

    return f"{CONDA_INSTALL_BASE} {conda_package_type} {conda_channels}"

def get_base_download_url_for_repo(repo: str, channel: str, gpu_arch_type: str, desired_cuda: str) -> str:
    base_url_for_type = f"{DOWNLOAD_URL_BASE}/{repo}"
    base_url_for_type = base_url_for_type if channel == RELEASE else f"{base_url_for_type}/{channel}"

    if gpu_arch_type != "cpu":
        base_url_for_type= f"{base_url_for_type}/{desired_cuda}"
    else:
        base_url_for_type= f"{base_url_for_type}/{gpu_arch_type}"

    return base_url_for_type

def get_libtorch_install_command(os: str, channel: str, gpu_arch_type: str, libtorch_variant: str, devtoolset: str, desired_cuda: str, libtorch_config: str) -> str:
    prefix = "libtorch" if os != 'windows' else "libtorch-win"
    _libtorch_variant = f"{libtorch_variant}-{libtorch_config}" if libtorch_config == 'debug' else libtorch_variant
    build_name = f"{prefix}-{devtoolset}-{_libtorch_variant}-latest.zip" if devtoolset ==  "cxx11-abi" else f"{prefix}-{_libtorch_variant}-latest.zip"

    if os == 'macos':
        build_name = "libtorch-macos-latest.zip"
        if channel == RELEASE:
            build_name = f"libtorch-macos-{mod.CURRENT_VERSION}.zip"
    elif os == 'linux' and (channel == RELEASE or channel == TEST):
        build_name = f"{prefix}-{devtoolset}-{_libtorch_variant}-{mod.CURRENT_VERSION}%2B{desired_cuda}.zip" if devtoolset ==  "cxx11-abi" else f"{prefix}-{_libtorch_variant}-{mod.CURRENT_VERSION}%2B{desired_cuda}.zip"
    elif os == 'windows' and (channel == RELEASE or channel == TEST):
        build_name = f"{prefix}-shared-with-deps-debug-{mod.CURRENT_VERSION}%2B{desired_cuda}.zip" if libtorch_config == 'debug' else f"{prefix}-shared-with-deps-{mod.CURRENT_VERSION}%2B{desired_cuda}.zip"
    elif os == "windows" and channel == NIGHTLY:
        build_name = f"{prefix}-shared-with-deps-debug-latest.zip" if libtorch_config == 'debug' else f"{prefix}-shared-with-deps-latest.zip"

    return f"{get_base_download_url_for_repo('libtorch', channel, gpu_arch_type, desired_cuda)}/{build_name}"

def get_wheel_install_command(os: str, channel: str, gpu_arch_type: str, gpu_arch_version: str, desired_cuda: str, python_version: str) -> str:
    if channel == RELEASE and ((gpu_arch_version == "11.7" and os == "linux") or (gpu_arch_type == "cpu" and (os == "windows" or os == "macos"))):
        return f"{WHL_INSTALL_BASE} {PACKAGES_TO_INSTALL_WHL}"
    else:
        whl_install_command = f"{WHL_INSTALL_BASE} --pre {PACKAGES_TO_INSTALL_WHL}" if channel == "nightly" else f"{WHL_INSTALL_BASE} {PACKAGES_TO_INSTALL_WHL}"
        return f"{whl_install_command} --index-url {get_base_download_url_for_repo('whl', channel, gpu_arch_type, desired_cuda)}"

def generate_conda_matrix(os: str, channel: str, with_cuda: str, limit_pr_builds: bool) -> List[Dict[str, str]]:
    ret: List[Dict[str, str]] = []
    arches = ["cpu"]
    python_versions = list(mod.PYTHON_ARCHES)

    # remove python 3.11 conda from macos x86
    if(os == "macos"):
        python_versions = list_without(python_versions, ["3.11"])

    if with_cuda == ENABLE and (os == "linux" or os == "windows"):
        arches += mod.CUDA_ARCHES

    if limit_pr_builds:
        python_versions = [ python_versions[0] ]

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
                    "container_image": mod.CONDA_CONTAINER_IMAGES[arch_version],
                    "package_type": "conda",
                    "build_name": f"conda-py{python_version}-{gpu_arch_type}{gpu_arch_version}".replace(
                        ".", "_"
                    ),
                    "validation_runner": validation_runner(gpu_arch_type, os),
                    "channel": channel,
                    "stable_version": mod.CURRENT_VERSION,
                    "installation": get_conda_install_command(channel, gpu_arch_type, arch_version, os)
                }
            )

    return ret


def generate_libtorch_matrix(
    os: str,
    channel: str,
    with_cuda: str,
    limit_pr_builds: str,
    abi_versions: Optional[List[str]] = None,
    arches: Optional[List[str]] = None,
    libtorch_variants: Optional[List[str]] = None,
) -> List[Dict[str, str]]:

    ret: List[Dict[str, str]] = []

    # macos-arm64 does not have any libtorch builds
    if os == "macos-arm64":
        return ret

    if arches is None:
        arches = ["cpu"]

        if with_cuda == ENABLE:
            if os == "linux":
                arches += mod.CUDA_ARCHES
                arches += mod.ROCM_ARCHES
            elif os == "windows":
                arches += mod.CUDA_ARCHES

    if abi_versions is None:
        if os == "windows":
            abi_versions = [RELEASE, DEBUG]
        elif os == "linux":
            abi_versions = [PRE_CXX11_ABI, CXX11_ABI]
        elif os == "macos":
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

                # For windows release we support only shared-with-deps variant
                # see: https://github.com/pytorch/pytorch/issues/87782
                if os == 'windows' and channel == RELEASE and libtorch_variant != "shared-with-deps":
                    continue

                desired_cuda = translate_desired_cuda(gpu_arch_type, gpu_arch_version)
                devtoolset = abi_version if os != "windows" else ""
                libtorch_config = abi_version if os == "windows" else ""
                ret.append(
                    {
                        "gpu_arch_type": gpu_arch_type,
                        "gpu_arch_version": gpu_arch_version,
                        "desired_cuda": desired_cuda,
                        "libtorch_variant": libtorch_variant,
                        "libtorch_config": libtorch_config,
                        "devtoolset": devtoolset,
                        "container_image": mod.LIBTORCH_CONTAINER_IMAGES[
                            (arch_version, abi_version)
                        ]
                        if os != "windows"
                        else "",
                        "package_type": "libtorch",
                        "build_name": f"libtorch-{gpu_arch_type}{gpu_arch_version}-{libtorch_variant}-{abi_version}".replace(
                            ".", "_"
                        ),
                        # Please noe since libtorch validations are minimal, we use CPU runners
                        "validation_runner": validation_runner("cpu", os),
                        "installation": get_libtorch_install_command(os, channel, gpu_arch_type, libtorch_variant, devtoolset, desired_cuda, libtorch_config),
                        "channel": channel,
                        "stable_version": mod.CURRENT_VERSION
                    }
                )
    return ret


def generate_wheels_matrix(
    os: str,
    channel: str,
    with_cuda: str,
    limit_pr_builds: bool,
    arches: Optional[List[str]] = None,
    python_versions: Optional[List[str]] = None,
) -> List[Dict[str, str]]:
    package_type = "wheel"

    if python_versions is None:
        # Define default python version
        python_versions = list(mod.PYTHON_ARCHES)

    if os == "linux":
        # NOTE: We only build manywheel packages for linux
        package_type = "manywheel"

    upload_to_base_bucket = "yes"
    if arches is None:
        # Define default compute archivectures
        arches = ["cpu"]

        if with_cuda == ENABLE:
            upload_to_base_bucket = "no"
            if os == "linux":
                arches += mod.CUDA_ARCHES + mod.ROCM_ARCHES
            elif os == "windows":
                arches += mod.CUDA_ARCHES

    if limit_pr_builds:
        python_versions = [ python_versions[0] ]

    ret: List[Dict[str, str]] = []
    for python_version in python_versions:
        for arch_version in arches:
            gpu_arch_type = arch_type(arch_version)
            gpu_arch_version = "" if arch_version == "cpu" else arch_version

            desired_cuda = translate_desired_cuda(gpu_arch_type, gpu_arch_version)
            ret.append(
                {
                    "python_version": python_version,
                    "gpu_arch_type": gpu_arch_type,
                    "gpu_arch_version": gpu_arch_version,
                    "desired_cuda": desired_cuda,
                    "container_image": mod.WHEEL_CONTAINER_IMAGES[arch_version],
                    "package_type": package_type,
                    "build_name": f"{package_type}-py{python_version}-{gpu_arch_type}{gpu_arch_version}".replace(
                        ".", "_"
                    ),
                    "validation_runner": validation_runner(gpu_arch_type, os),
                    "installation": get_wheel_install_command(os, channel, gpu_arch_type, gpu_arch_version, desired_cuda, python_version),
                    "channel": channel,
                    "upload_to_base_bucket": upload_to_base_bucket,
                    "stable_version": mod.CURRENT_VERSION
                }
            )
    return ret


GENERATING_FUNCTIONS_BY_PACKAGE_TYPE = {
    "wheel": generate_wheels_matrix,
    "conda": generate_conda_matrix,
    "libtorch": generate_libtorch_matrix,
}

def main(args) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--package-type",
        help="Package type to lookup for, also supports comma separated values",
        type=str,
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
    parser.add_argument(
        "--with-cuda",
        help="Build with Cuda?",
        type=str,
        choices=[ENABLE, DISABLE],
        default=os.getenv("WITH_CUDA", ENABLE),
    )
    # By default this is false for this script but expectation is that the caller
    # workflow will default this to be true most of the time, where a pull
    # request is synchronized and does not contain the label "ciflow/binaries/all"
    parser.add_argument(
        "--limit-pr-builds",
        help="Limit PR builds to single python/cuda config",
        type=str,
        choices=["true", "false"],
        default=os.getenv("LIMIT_PR_BUILDS", "false"),
    )



    options = parser.parse_args(args)
    includes = []

    package_types = options.package_type.split(",")
    if len(package_types) == 1:
        package_types = PACKAGE_TYPES if options.package_type == "all" else [options.package_type]

    channels = CUDA_ARCHES_DICT.keys() if options.channel == "all" else [options.channel]

    for channel in channels:
        for package in package_types:
            initialize_globals(channel)
            if package == "wheel":
                includes.extend(
                    GENERATING_FUNCTIONS_BY_PACKAGE_TYPE[package](options.operating_system,
                                                                channel,
                                                                options.with_cuda,
                                                                options.limit_pr_builds == "true")
                    )
            else:
                includes.extend(
                    GENERATING_FUNCTIONS_BY_PACKAGE_TYPE[package](options.operating_system,
                                                                channel,
                                                                options.with_cuda,
                                                                options.limit_pr_builds == "true")
                    )


    print(json.dumps({"include": includes}))

if __name__ == "__main__":
    main(sys.argv[1:])
