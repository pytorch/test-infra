#!/usr/bin/env python3
# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
#
# This source code is licensed under the BSD-style license found in the
# LICENSE file in the root directory of this source tree.

import json
import logging
import os
import platform
import socket
from logging import info
from typing import Any, Dict

import psutil


logging.basicConfig(level=logging.INFO)


def set_output(name: str, val: Any) -> None:
    if os.getenv("GITHUB_OUTPUT"):
        with open(str(os.getenv("GITHUB_OUTPUT")), "a") as env:
            print(f"{name}={val}", file=env)
    else:
        print(f"::set-output name={name}::{val}")


def get_runner_info() -> Dict[str, Any]:
    device_name = ""
    device_type = ""

    try:
        import torch

        if torch.cuda.is_available():
            if torch.version.hip:
                device_name = "rocm"
            elif torch.version.cuda:
                device_name = "cuda"

            device_type = torch.cuda.get_device_name()

    except ImportError:
        info("Fail to import torch to get the device name")

    runner_info = {
        "cpu_info": platform.processor(),
        "cpu_count": psutil.cpu_count(),
        "avail_mem_in_gb": int(psutil.virtual_memory().total / (1024 * 1024 * 1024)),
        "extra_info": {
            "hostname": socket.gethostname(),
        },
    }

    if device_name and device_type:
        runner_info["name"] = device_name
        runner_info["type"] = device_type
        runner_info["gpu_count"] = torch.cuda.device_count()
        runner_info["avail_gpu_mem_in_gb"] = int(
            torch.cuda.get_device_properties(0).total_memory
            * torch.cuda.device_count()
            / (1024 * 1024 * 1024)
        )
    else:
        # Check if the workflow has already set the device name and type
        runner_info["name"] = os.getenv("DEVICE_NAME", "")
        runner_info["type"] = os.getenv("DEVICE_TYPE", "")

    return runner_info


def main() -> None:
    runner_info = get_runner_info()
    set_output("runners", json.dumps([runner_info]))


if __name__ == "__main__":
    main()
