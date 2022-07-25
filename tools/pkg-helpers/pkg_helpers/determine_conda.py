import argparse
import os
import sys
import json
import re
import subprocess


def normalize_gpu_arch_version(gpu_arch_version: str):
    ver_one = gpu_arch_version
    ver_two = gpu_arch_version
    if gpu_arch_version != "cpu":
        ver_one = gpu_arch_version.replace("cu", "cuda")
        ver_two = (gpu_arch_version[:-1] + "." + gpu_arch_version[-1]).replace(
            "cu", "cuda"
        )
    return ver_one, ver_two


def get_conda_version(
    conda_search: str, gpu_arch_version: str, python_version: str
) -> str:
    ver_one, ver_two = normalize_gpu_arch_version(gpu_arch_version)
    for pkg in conda_search["pytorch"]:
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
            return re.sub(r"\\+.*$", "", pkg["version"])
