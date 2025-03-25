#!/usr/bin/env python3

import copy
import datetime
import json
import logging
import os
import random
import string
import sys
import time
from argparse import ArgumentParser
from logging import info
from re import A
from typing import Any

import requests


GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
logging.basicConfig(level=logging.INFO)


def parse_args() -> Any:
    parser = ArgumentParser(
        "Run Android and iOS tests on AWS Device Farm via github actions workflow run"
    )
    parser.add_argument(
        "--branch",
        type=str,
        default="main",
        required=False,
        help="what gh branch to use in pytorch/executorch",
    )

    app_type = parser.add_mutually_exclusive_group(required=True)
    app_type.add_argument(
        "--android",
        action="store_true",
        required=False,
        help="run the test on Android",
    )
    app_type.add_argument(
        "--ios",
        action="store_true",
        required=False,
        help="run the test on iOS",
    )

    parser.add_argument(
        "--models",
        type=str,
        required=False,
        default="llama",
        help="the model to run on. Default is llama.",
    )
    parser.add_argument(
        "--devices",
        type=str,
        required=False,
        default="",
        help="specific devices to run on. Default is s22 for android and iphone 15 for ios.",
    )
    parser.add_argument(
        "--benchmark_configs",
        type=str,
        required=False,
        default="",
        help="The list of configs used in the benchmark",
    )

    parser.add_argument(
        "--debug",
        action="store_true",
        help="debug mode, the artifacts won't be uploaded to s3, it should mainly used in local env",
    )

    # in case when removing the flag, the mobile jobs does not failed due to unrecognized flag.
    args, unknown = parser.parse_known_args()
    if len(unknown) > 0:
        info(f"detected unknown flags: {unknown}")
    return args


def run_workflow(app_type, branch, models, devices, benchmark_configs):
    dispatch_hook = "/dispatches"
    if app_type == "android":
        url = f"https://api.github.com/repos/pytorch/executorch/actions/workflows/android-perf.yml"
    else:
        url = f"https://api.github.com/repos/pytorch/executorch/actions/workflows/apple-perf.yml"

    headers = {
        "Accept": "application/vnd.github.v3+json",
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    data = {
        "ref": f"{branch}",
        "inputs": {
            "models": f"{models}",
            "devices": f"{devices}",
            "benchmark_configs": f"{benchmark_configs}",
        },
    }

    resp = requests.post(url + dispatch_hook, headers=headers, data=json.dumps(data))
    if resp.status_code != 204:
        raise Exception(f"Failed to start workflow: {resp.text}")
    else:
        print("Workflow started successfully.")
        if app_type == "android":
            print(
                "Find your workflow run here: https://github.com/pytorch/executorch/actions/workflows/android-perf.yml"
            )
        else:
            print(
                "Find your workflow run here: https://github.com/pytorch/executorch/actions/workflows/apple-perf.yml"
            )


def main() -> None:
    args = parse_args()
    if args.android:
        resp = run_workflow(
            "android", args.branch, args.models, args.devices, args.benchmark_configs
        )
    elif args.ios:
        resp = run_workflow(
            "ios", args.branch, args.models, args.devices, args.benchmark_configs
        )
    else:
        raise Exception(
            "No app type specified. Please specify either --android or --ios."
        )


if __name__ == "__main__":
    main()
