#!/usr/bin/env python3

import argparse
import os
import sys
import json
import subprocess
import shlex

from .conda import get_conda_variables


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Determine pytorch dependencies")
    parser.add_argument(
        "--package-type",
        help="Package type to lookup for",
        type=str,
        choices=["wheel", "conda"],
        default=os.getenv("PACKAGE_TYPE", "wheel"),
    )
    parser.add_argument(
        "--channel",
        help="Channel to look in",
        type=str,
        default=os.getenv("CHANNEL", "nightly"),
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
    options = parser.parse_args()
    return options


def main():
    options = parse_args()
    if options.package_type == "conda":
        output = subprocess.check_output(
            shlex.split(
                f"conda search --json 'pytorch[channel=pytorch-{options.channel}]'"
            ),
            stderr=subprocess.STDOUT,
        )
        conda_search = json.loads(output)
        for variable in get_conda_variables(
            conda_search, sys.platform, options.gpu_arch_version, options.python_version
        ):
            print(variable)
    if options.package_type == "wheel":
        raise NotImplementedError()
    pass


if __name__ == "__main__":
    main()
