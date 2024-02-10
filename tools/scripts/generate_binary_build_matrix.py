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
import json
import os
import sys

from typing import Dict, List, Optional, Tuple

mod = sys.modules[__name__]

PYTHON_ARCHES_DICT = {
    # TODO (huydhn): 3.12 is only enabled in nightly and test.
    # Release should be enabled after release is complete.
    "nightly": ["3.8", "3.9", "3.10", "3.11", "3.12"],
    "test": ["3.8", "3.9", "3.10", "3.11", "3.12"],
    "release": ["3.8", "3.9", "3.10", "3.11", "3.12"],
}
CUDA_ARCHES_DICT = {
    "nightly": ["11.8", "12.1"],
    "test": ["11.8", "12.1"],
    "release": ["11.8", "12.1"],
}
ROCM_ARCHES_DICT = {
    "nightly": ["5.7", "6.0"],
    "test": ["5.6", "5.7"],
    "release": ["5.6", "5.7"],
}

PACKAGE_TYPES = ["wheel", "conda", "libtorch"]
PRE_CXX11_ABI = "pre-cxx11"
CXX11_ABI = "cxx11-abi"
RELEASE = "release"
DEBUG = "debug"
NIGHTLY = "nightly"
TEST = "test"

# OS constants
LINUX = "linux"
LINUX_AARCH64 = "linux-aarch64"
MACOS = "macos"
MACOS_ARM64 = "macos-arm64"
WINDOWS = "windows"

# Accelerator architectures
CPU = "cpu"
CPU_AARCH64 = "cpu-aarch64"
CUDA = "cuda"
ROCM = "rocm"


CURRENT_CANDIDATE_VERSION = "2.2.0"
CURRENT_STABLE_VERSION = "2.2.0"
mod.CURRENT_VERSION = CURRENT_STABLE_VERSION

# By default use Nightly for CUDA arches
mod.CUDA_ARCHES = CUDA_ARCHES_DICT[NIGHTLY]
mod.ROCM_ARCHES = ROCM_ARCHES_DICT[NIGHTLY]
mod.PYTHON_ARCHES = PYTHON_ARCHES_DICT[NIGHTLY]

LINUX_GPU_RUNNER = "linux.g5.4xlarge.nvidia.gpu"
LINUX_CPU_RUNNER = "linux.2xlarge"
LINUX_AARCH64_RUNNER = "linux.arm64.2xlarge"
WIN_GPU_RUNNER = "windows.8xlarge.nvidia.gpu"
WIN_CPU_RUNNER = "windows.4xlarge"
MACOS_M1_RUNNER = "macos-m1-stable"
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
        return CUDA
    elif arch_version in mod.ROCM_ARCHES:
        return ROCM
    elif arch_version == CPU_AARCH64:
        return CPU_AARCH64
    else:  # arch_version should always be CPU in this case
        return CPU


def validation_runner(arch_type: str, os: str) -> str:
    if os == LINUX:
        if arch_type == CUDA:
            return LINUX_GPU_RUNNER
        else:
            return LINUX_CPU_RUNNER
    elif os == LINUX_AARCH64:
        return LINUX_AARCH64_RUNNER
    elif os == WINDOWS:
        if arch_type == CUDA:
            return WIN_GPU_RUNNER
        else:
            return WIN_CPU_RUNNER
    elif os == MACOS_ARM64:
        return MACOS_M1_RUNNER
    elif os == MACOS:
        return MACOS_RUNNER
    else:  # default to linux cpu runner
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
        CPU: "pytorch/manylinux-builder:cpu",
        CPU_AARCH64: "pytorch/manylinuxaarch64-builder:cpu-aarch64",
    }
    mod.CONDA_CONTAINER_IMAGES = {
        **{
            gpu_arch: f"pytorch/conda-builder:cuda{gpu_arch}"
            for gpu_arch in mod.CUDA_ARCHES
        },
        CPU: "pytorch/conda-builder:cpu",
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
        (CPU, PRE_CXX11_ABI): "pytorch/manylinux-builder:cpu",
        (CPU, CXX11_ABI): "pytorch/libtorch-cxx11-builder:cpu",
    }


def translate_desired_cuda(gpu_arch_type: str, gpu_arch_version: str) -> str:
    return {
        CPU: "cpu",
        CPU_AARCH64: CPU,
        CUDA: f"cu{gpu_arch_version.replace('.', '')}",
        ROCM: f"rocm{gpu_arch_version}",
    }.get(gpu_arch_type, gpu_arch_version)


def list_without(in_list: List[str], without: List[str]) -> List[str]:
    return [item for item in in_list if item not in without]


def get_conda_install_command(
    channel: str, gpu_arch_type: str, arch_version: str, os: str
) -> str:
    pytorch_channel = "pytorch" if channel == RELEASE else f"pytorch-{channel}"
    conda_channels = f"-c {pytorch_channel}"
    conda_package_type = ""
    if gpu_arch_type == CUDA:
        conda_package_type = f"pytorch-cuda={arch_version}"
        conda_channels = f"{conda_channels} -c nvidia"
    elif os not in (MACOS, MACOS_ARM64):
        conda_package_type = "cpuonly"
    else:
        return f"conda install {pytorch_channel}::{PACKAGES_TO_INSTALL_CONDA} {conda_channels}"

    return f"{CONDA_INSTALL_BASE} {conda_package_type} {conda_channels}"


def get_base_download_url_for_repo(
    repo: str, channel: str, gpu_arch_type: str, desired_cuda: str
) -> str:
    base_url_for_type = f"{DOWNLOAD_URL_BASE}/{repo}"
    base_url_for_type = (
        base_url_for_type if channel == RELEASE else f"{base_url_for_type}/{channel}"
    )

    if gpu_arch_type != CPU:
        base_url_for_type = f"{base_url_for_type}/{desired_cuda}"
    else:
        base_url_for_type = f"{base_url_for_type}/{gpu_arch_type}"

    return base_url_for_type


def get_libtorch_install_command(
    os: str,
    channel: str,
    gpu_arch_type: str,
    libtorch_variant: str,
    devtoolset: str,
    desired_cuda: str,
    libtorch_config: str,
) -> str:
    prefix = "libtorch" if os != WINDOWS else "libtorch-win"
    _libtorch_variant = (
        f"{libtorch_variant}-{libtorch_config}"
        if libtorch_config == "debug"
        else libtorch_variant
    )
    build_name = (
        f"{prefix}-{devtoolset}-{_libtorch_variant}-latest.zip"
        if devtoolset == "cxx11-abi"
        else f"{prefix}-{_libtorch_variant}-latest.zip"
    )

    if os in [MACOS, MACOS_ARM64]:
        arch = "x86_64" if os == MACOS else "arm64"
        build_name = f"libtorch-macos-{arch}-latest.zip"
        if channel in [RELEASE, TEST]:
            build_name = f"libtorch-macos-{arch}-{mod.CURRENT_VERSION}.zip"

    elif os == LINUX and (channel == RELEASE or channel == TEST):
        build_name = (
            f"{prefix}-{devtoolset}-{_libtorch_variant}-{mod.CURRENT_VERSION}%2B{desired_cuda}.zip"
            if devtoolset == "cxx11-abi"
            else f"{prefix}-{_libtorch_variant}-{mod.CURRENT_VERSION}%2B{desired_cuda}.zip"
        )
    elif os == WINDOWS and (channel == RELEASE or channel == TEST):
        build_name = (
            f"{prefix}-shared-with-deps-debug-{mod.CURRENT_VERSION}%2B{desired_cuda}.zip"
            if libtorch_config == "debug"
            else f"{prefix}-shared-with-deps-{mod.CURRENT_VERSION}%2B{desired_cuda}.zip"
        )
    elif os == WINDOWS and channel == NIGHTLY:
        build_name = (
            f"{prefix}-shared-with-deps-debug-latest.zip"
            if libtorch_config == "debug"
            else f"{prefix}-shared-with-deps-latest.zip"
        )

    return f"{get_base_download_url_for_repo('libtorch', channel, gpu_arch_type, desired_cuda)}/{build_name}"


def get_wheel_install_command(
    os: str,
    channel: str,
    gpu_arch_type: str,
    gpu_arch_version: str,
    desired_cuda: str,
    python_version: str,
    use_only_dl_pytorch_org: bool,
) -> str:

    index_url_option = "--index-url" if os != LINUX_AARCH64 else "--extra-index-url"
    if  channel == RELEASE and (not use_only_dl_pytorch_org) and (
        (gpu_arch_version == "12.1" and os == LINUX)
        or (
            gpu_arch_type == CPU
            and os in [WINDOWS, MACOS, MACOS_ARM64]
        )
        or (os == LINUX_AARCH64)
    ):
        return f"{WHL_INSTALL_BASE} {PACKAGES_TO_INSTALL_WHL}"
    else:
        whl_install_command = (
            f"{WHL_INSTALL_BASE} --pre {PACKAGES_TO_INSTALL_WHL}"
            if channel == "nightly"
            else f"{WHL_INSTALL_BASE} {PACKAGES_TO_INSTALL_WHL}"
        )
        return f"{whl_install_command} {index_url_option} {get_base_download_url_for_repo('whl', channel, gpu_arch_type, desired_cuda)}"


def generate_conda_matrix(
    os: str,
    channel: str,
    with_cuda: str,
    with_rocm: str,
    with_cpu: str,
    limit_pr_builds: bool,
    use_only_dl_pytorch_org: bool,
) -> List[Dict[str, str]]:
    ret: List[Dict[str, str]] = []
    python_versions = list(mod.PYTHON_ARCHES)

    arches = []

    if with_cpu == ENABLE:
        arches += [CPU]

    if with_cuda == ENABLE:
        if os == LINUX or os == WINDOWS:
            arches += mod.CUDA_ARCHES

    if limit_pr_builds:
        python_versions = [python_versions[0]]

    for python_version in python_versions:
        # We don't currently build conda packages for rocm
        for arch_version in arches:
            gpu_arch_type = arch_type(arch_version)
            gpu_arch_version = "" if arch_version == CPU else arch_version

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
                    "installation": get_conda_install_command(
                        channel, gpu_arch_type, arch_version, os
                    ),
                }
            )

    return ret


def generate_libtorch_matrix(
    os: str,
    channel: str,
    with_cuda: str,
    with_rocm: str,
    with_cpu: str,
    limit_pr_builds: bool,
    use_only_dl_pytorch_org: bool,
    abi_versions: Optional[List[str]] = None,
    arches: Optional[List[str]] = None,
    libtorch_variants: Optional[List[str]] = None,
) -> List[Dict[str, str]]:
    ret: List[Dict[str, str]] = []

    if arches is None:
        arches = []

        if with_cpu == ENABLE:
            arches += [CPU]

        if with_cuda == ENABLE:
            if os == LINUX or os == WINDOWS:
                arches += mod.CUDA_ARCHES

        if with_rocm == ENABLE:
            if os == LINUX:
                arches += mod.ROCM_ARCHES

    if abi_versions is None:
        if os == WINDOWS:
            abi_versions = [RELEASE, DEBUG]
        elif os == LINUX:
            abi_versions = [PRE_CXX11_ABI, CXX11_ABI]
        elif os in [MACOS, MACOS_ARM64]:
            abi_versions = [CXX11_ABI]

    if libtorch_variants is None:
        libtorch_variants = [
            "shared-with-deps",
        ]

    for abi_version in abi_versions:
        for arch_version in arches:
            for libtorch_variant in libtorch_variants:
                # one of the values in the following list must be exactly
                # CXX11_ABI, but the precise value of the other one doesn't
                # matter
                gpu_arch_type = arch_type(arch_version)
                gpu_arch_version = "" if arch_version == CPU else arch_version

                desired_cuda = translate_desired_cuda(gpu_arch_type, gpu_arch_version)
                devtoolset = abi_version if os != WINDOWS else ""
                libtorch_config = abi_version if os == WINDOWS else ""
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
                        if os != WINDOWS
                        else "",
                        "package_type": "libtorch",
                        "build_name": f"libtorch-{gpu_arch_type}{gpu_arch_version}-{libtorch_variant}-{abi_version}".replace(
                            ".", "_"
                        ),
                        # Please noe since libtorch validations are minimal, we use CPU runners
                        "validation_runner": validation_runner(CPU, os),
                        "installation": get_libtorch_install_command(
                            os,
                            channel,
                            gpu_arch_type,
                            libtorch_variant,
                            devtoolset,
                            desired_cuda,
                            libtorch_config,
                        ),
                        "channel": channel,
                        "stable_version": mod.CURRENT_VERSION,
                    }
                )
    return ret


def generate_wheels_matrix(
    os: str,
    channel: str,
    with_cuda: str,
    with_rocm: str,
    with_cpu: str,
    limit_pr_builds: bool,
    use_only_dl_pytorch_org: bool,
    arches: Optional[List[str]] = None,
    python_versions: Optional[List[str]] = None,
) -> List[Dict[str, str]]:
    package_type = "wheel"

    if python_versions is None:
        # Define default python version
        python_versions = list(mod.PYTHON_ARCHES)

    if os == LINUX:
        # NOTE: We only build manywheel packages for linux
        package_type = "manywheel"

    upload_to_base_bucket = "yes"
    if arches is None:
        # Define default compute architectures
        arches = []

        if with_cpu == ENABLE:
            arches += [CPU]

        if os == LINUX_AARCH64:
            # Only want the one arch as the CPU type is different and
            # uses different build/test scripts
            arches = [CPU_AARCH64]

        if with_cuda == ENABLE:
            upload_to_base_bucket = "no"
            if os == LINUX or os == WINDOWS:
                arches += mod.CUDA_ARCHES

        if with_rocm == ENABLE:
            if os == LINUX:
                arches += mod.ROCM_ARCHES

    if limit_pr_builds:
        python_versions = [python_versions[0]]

    ret: List[Dict[str, str]] = []
    for python_version in python_versions:
        for arch_version in arches:
            gpu_arch_type = arch_type(arch_version)
            gpu_arch_version = (
                ""
                if arch_version in [CPU, CPU_AARCH64]
                else arch_version
            )

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
                    "installation": get_wheel_install_command(
                        os,
                        channel,
                        gpu_arch_type,
                        gpu_arch_version,
                        desired_cuda,
                        python_version,
                        use_only_dl_pytorch_org,
                    ),
                    "channel": channel,
                    "upload_to_base_bucket": upload_to_base_bucket,
                    "stable_version": mod.CURRENT_VERSION,
                }
            )
    return ret


GENERATING_FUNCTIONS_BY_PACKAGE_TYPE = {
    "wheel": generate_wheels_matrix,
    "conda": generate_conda_matrix,
    "libtorch": generate_libtorch_matrix,
}


def generate_build_matrix(
    package_type: str,
    operating_system: str,
    channel: str,
    with_cuda: str,
    with_rocm: str,
    with_cpu: str,
    limit_pr_builds: str,
    use_only_dl_pytorch_org: str,
) -> Dict[str, List[Dict[str, str]]]:
    includes = []

    package_types = package_type.split(",")
    if len(package_types) == 1:
        package_types = PACKAGE_TYPES if package_type == "all" else [package_type]

    channels = CUDA_ARCHES_DICT.keys() if channel == "all" else [channel]

    for channel in channels:
        for package in package_types:
            initialize_globals(channel)
            includes.extend(
                GENERATING_FUNCTIONS_BY_PACKAGE_TYPE[package](
                    operating_system,
                    channel,
                    with_cuda,
                    with_rocm,
                    with_cpu,
                    limit_pr_builds == "true",
                    use_only_dl_pytorch_org == "true",
                )
            )

    return {"include": includes}


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
        default=os.getenv("OS", LINUX),
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
    parser.add_argument(
        "--with-rocm",
        help="Build with Rocm?",
        type=str,
        choices=[ENABLE, DISABLE],
        default=os.getenv("WITH_ROCM", ENABLE),
    )
    parser.add_argument(
        "--with-cpu",
        help="Build with CPU?",
        type=str,
        choices=[ENABLE, DISABLE],
        default=os.getenv("WITH_CPU", ENABLE),
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
    # This is used when testing release builds to test release binaries
    # only from download.pytorch.org. When pipy binaries are not released yet.
    parser.add_argument(
        "--use-only-dl-pytorch-org",
        help="Use only download.pytorch.org when gen wheel install command?",
        type=str,
        choices=["true", "false"],
        default=os.getenv("USE_ONLY_DL_PYTORCH_ORG", "false"),
    )

    options = parser.parse_args(args)

    assert (
        options.with_cuda or options.with_rocm or options.with_cpu
    ), "Must build with either CUDA, ROCM, or CPU support."

    build_matrix = generate_build_matrix(
        options.package_type,
        options.operating_system,
        options.channel,
        options.with_cuda,
        options.with_rocm,
        options.with_cpu,
        options.limit_pr_builds,
        options.use_only_dl_pytorch_org,
    )

    print(json.dumps(build_matrix))


if __name__ == "__main__":
    main(sys.argv[1:])
