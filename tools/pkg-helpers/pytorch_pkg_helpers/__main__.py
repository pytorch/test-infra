#!/usr/bin/env python3

import argparse
import json
import os
import shlex
import subprocess
import sys

from .conda import get_conda_variables
from .cuda import get_cuda_variables
from .macos import get_macos_variables
from .version import get_version_variables
from .wheel import get_wheel_variables


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Determine pytorch dependencies")
    parser.add_argument(
        "--package-type",
        help="Package type to lookup for",
        type=str,
        choices=["wheel", "conda"],
        # BUILD_TYPE for legacy scripts
        default=os.getenv("PACKAGE_TYPE", os.getenv("BUILD_TYPE", "wheel")),
    )
    parser.add_argument(
        "--channel",
        help="Channel to look in",
        choices=["nightly", "test"],
        type=str,
        default=os.getenv("CHANNEL", "nightly"),
    )
    parser.add_argument(
        "--platform",
        help="Platform to generate for",
        type=str,
        default=sys.platform,
    )
    parser.add_argument(
        "--gpu-arch-version",
        type=str,
        help="GPU arch version to look for",
        # CU_VERSION for legacy scripts
        default=os.getenv("GPU_ARCH_VERSION", os.getenv("CU_VERSION", "cpu")),
    )
    parser.add_argument(
        "--python-version",
        type=str,
        help="Python version to look for",
        default=os.getenv(
            "PYTHON_VERSION", ".".join([str(num) for num in sys.version_info[0:2]])
        ),
    )
    parser.add_argument(
        "--pytorch-version",
        type=str,
        help="PyTorch version to use",
        default=os.getenv("PYTORCH_VERSION", ""),
    )
    parser.add_argument(
        "--base-build-version",
        type=str,
        help="Base build version to use",
        # BUILD_VERSION for legacy scripts
        default=os.getenv("BUILD_VERSION", os.getenv("BASE_BUILD_VERSION", "")),
    )
    options = parser.parse_args()
    return options


def main():
    options = parse_args()
    variables = []
    if options.package_type == "conda":
        # TODO: Eventually it'd be nice to not have to rely on conda being installed
        output = subprocess.check_output(
            shlex.split(
                f"conda search --json 'pytorch[channel=pytorch-{options.channel}]'"
            ),
            stderr=subprocess.STDOUT,
        )
        conda_search = json.loads(output)
        variables.extend(
            get_conda_variables(
                conda_search=conda_search,
                platform=options.platform,
                gpu_arch_version=options.gpu_arch_version,
                python_version=options.python_version,
                pytorch_version=options.pytorch_version,
            )
        )
    elif options.package_type == "wheel":
        variables.extend(
            get_wheel_variables(
                platform=options.platform,
                gpu_arch_version=options.gpu_arch_version,
                python_version=options.python_version,
                pytorch_version=options.pytorch_version,
                channel=options.channel,
            )
        )
    if options.platform == "darwin":
        variables.extend(get_macos_variables())
    variables.extend(
        get_cuda_variables(
            options.package_type, options.platform, options.gpu_arch_version
        )
    )
    variables.extend(
        get_version_variables(
            package_type=options.package_type,
            channel=options.channel,
            gpu_arch_version=options.gpu_arch_version,
            base_build_version=options.base_build_version,
            platform=options.platform,
        )
    )
    for variable in sorted(variables):
        print(variable)


if __name__ == "__main__":
    main()
