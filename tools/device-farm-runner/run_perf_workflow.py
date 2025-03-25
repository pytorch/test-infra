#!/usr/bin/env python3

import copy
import datetime
import json
import logging
import os
import random
from re import A
import string
import sys
import time
from argparse import ArgumentParser
from logging import info
from typing import Any

import requests

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
logging.basicConfig(level=logging.INFO)

def parse_args() -> Any:
    parser = ArgumentParser("Run Android and iOS tests on AWS Device Farm via github actions workflow run")
    parser.add_argument(
        "--branch", 
        type=str, 
        default="main", 
        required=False, 
        help="what gh branch to use in pytorch/executorch"
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
        help="the model to run on. Default is llama."
    )
    parser.add_argument(
        "--devices",
        type=str,
        required=False,
        default="",
        help="specific devices to run on. Default is s22 for android and iphone 15 for ios."
    )
    parser.add_argument(
        "--benchmark_configs",
        type=str,
        required=False,
        default="",
        help="The list of configs used in the benchmark"
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
    if app_type == "android":
        #url = "https://api.github.com/users/camyll"
        url = f"https://api.github.com/repos/pytorch/executorch/actions/workflows/android-perf.yml/dispatches"
    else: 
        url = f"https://api.github.com/repos/pytorch/executorch/actions/workflows/apple-perf.yml/dispatches"
    
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "X-GitHub-Api-Version": "2022-11-28",
        "X-Accepted-GitHub-Permissions": "contents=read"
    }

    data = '{"ref":"'+branch+'", inputs: {"branch": "'+branch+'", "models": "'+models+'", "device": "'+devices+'", "benchmark_configs": "'+benchmark_configs+'"}}'
    
    return requests.post(url, headers=headers, data=data)
    

def main() -> None:
    args = parse_args()
    if args.android:
        resp = run_workflow("android", args.branch, args.models, args.devices, args.benchmark_configs)
    elif args.ios:
        resp = run_workflow("ios", args.branch, args.models, args.devices, args.benchmark_configs)
    else:
        raise Exception("No app type specified. Please specify either --android or --ios.")
    print(resp.headers['X-Accepted-GitHub-Permissions'])
    print(json.loads(resp.text))
    print(resp.text)
    


if __name__ == "__main__":
    main()
