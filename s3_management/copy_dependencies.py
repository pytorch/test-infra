import argparse
import base64
import concurrent.futures
import dataclasses
import functools
import re
import time
from collections import defaultdict

from contextlib import suppress
from datetime import datetime
from os import makedirs, path
from re import match, search, sub
from typing import Dict, Iterable, List, Optional, Set, Type, TypeVar

import boto3
from packaging.version import InvalidVersion, parse as _parse_version, Version

PREFIXES = [
    "whl",
    "whl/nightly",
    "whl/test",
    "libtorch",
    "libtorch/nightly",
]

S3 = boto3.resource("s3")
CLIENT = boto3.client("s3")

# bucket for download.pytorch.org
BUCKET = S3.Bucket("pytorch")


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser("Manage S3 HTML indices for PyTorch")
    parser.add_argument("prefix", type=str, choices=PREFIXES + ["all"])
    parser.add_argument(
        "--package",
        help="should be the package and version we're trying to upgrade to: ie rocm6.3",
    )
    parser.add_argument(
        "--previous",
        help="should be the previous package and version we're trying to replace to: ie rocm6.2)",
    )

    return parser


def main() -> None:
    parser = create_parser()
    args = parser.parse_args()
    action = "copying package dependencies to new version subdir"
    prefixes = PREFIXES if args.prefix == "all" else [args.prefix]
    for prefix in prefixes:
        old_pkg = args.previous
        new_pkg = args.package
        print(f"INFO: {action} for '{prefix}/{new_pkg}'")
        stime = time.time()
        if args.package and args.previous:

            new_dir = f"{prefix}/{new_pkg}"
            new_dir = f"{prefix}/camyllhtest"

            old_dir = f"{prefix}/{old_pkg}"
            response = S3.meta.client.put_object(
                Body="", Bucket=BUCKET.name, Key=new_dir
            )
            print(f"DEBUG: Created {new_dir} with response {response}")
            copy_source = {"Bucket": BUCKET.name, "Key": old_dir}
            S3.meta.client.copy(CopySource=copy_source, Bucket=BUCKET, key=new_dir)
            # S3.meta.client.delete_object(Bucket=BUCKET, Key=old_dir)
        etime = time.time()
        print(
            f"DEBUG: Copying dependencies from {prefix}/{old_pkg} to {prefix}/{new_pkg} in {etime-stime:.2f} seconds"
        )


if __name__ == "__main__":
    main()
