#!/usr/bin/env python

import argparse
import base64
import concurrent.futures
import dataclasses
import functools
import time

from contextlib import suppress
from os import path, makedirs
from datetime import datetime
from collections import defaultdict
from typing import Iterable, List, Type, Dict, Set, TypeVar, Optional
from re import sub, match, search
from packaging.version import parse as _parse_version, Version, InvalidVersion

import boto3


S3 = boto3.resource('s3')
CLIENT = boto3.client('s3')

# bucket for download.pytorch.org
BUCKET = S3.Bucket('pytorch')

# bucket mirror just to hold index used with META CDN
BUCKET_META_CDN = S3.Bucket('pytorch-test')

ACCEPTED_FILE_EXTENSIONS = ("whl", "zip", "tar.gz")
ACCEPTED_SUBDIR_PATTERNS = [
    r"cu[0-9]+",            # for cuda
    r"rocm[0-9]+\.[0-9]+",  # for rocm
    "cpu",
    "xpu",
]
PREFIXES = [
    "whl/nightly",
    "libtorch/nightly",
]


PACKAGE_ALLOW_LIST = {
    "torch",
    "torchvision",
    "torchaudio",
    "torchtext",
    "torchdata"
}

# Should match torch-2.0.0.dev20221221+cu118-cp310-cp310-linux_x86_64.whl as:
# Group 1: torch-2.0.0.dev
# Group 2: 20221221
PACKAGE_DATE_REGEX = r"([a-zA-z]*-[0-9.]*.dev)([0-9]*)"


S3IndexType = TypeVar('S3IndexType', bound='S3Index')


@dataclasses.dataclass(frozen=False)
@functools.total_ordering
class S3Object:
    key: str
    orig_key: str
    checksum: Optional[str]
    size: Optional[int]

    def __hash__(self):
        return hash(self.key)

    def __str__(self):
        return self.key

    def __eq__(self, other):
        return self.key == other.key

    def __lt__(self, other):
        return self.key < other.key


def extract_package_build_time(full_package_name: str) -> datetime:
    result = search(PACKAGE_DATE_REGEX, full_package_name)
    if result is not None:
        with suppress(ValueError):
            # Ignore any value errors since they probably shouldn't be hidden anyways
            return datetime.strptime(result.group(2), "%Y%m%d")
    return datetime.now()


def safe_parse_version(ver_str: str) -> Version:
    try:
        return _parse_version(ver_str)
    except InvalidVersion:
        return Version("0.0.0")


class S3Index:
    def __init__(self: S3IndexType, objects: List[S3Object], prefix: str) -> None:
        self.objects = objects
        self.prefix = prefix.rstrip("/")
        # should dynamically grab subdirectories like whl/test/cu101
        # so we don't need to add them manually anymore
        self.subdirs = {
            path.dirname(obj.key) for obj in objects if path.dirname != prefix
        }

    def nightly_packages_to_move(self: S3IndexType) -> List[S3Object]:
        """
        This function is used to remove old nightly packages from the nightly index.
        It will remove all packages that are older than 1 year and keep the 20 newest packages.

        First Iteration:
        It works by first sorting the packages by version and then removing excluding all newer then
        2023.01.01 packages from algorithm. 

        Second Iteration:
        Creates Dictionary of package-version, sorted by version newest to oldest. 
        Leaves 20 newest packages for each version while all the other packages are included in the move.

        """
        # also includes versions without GPU specifier (i.e. cu102) for easier
        # sorting, sorts oldest to newest
        all_sorted_packages = sorted(
            {self.normalize_package_version(obj) for obj in self.objects},
            key=lambda name_ver: safe_parse_version(name_ver.split('-', 1)[-1]),
            reverse=False,
        )
        packages: Dict[str, int] = defaultdict(int)
        to_hide: Set[str] = set()
        for obj in all_sorted_packages:
            full_package_name = path.basename(obj)
            package_name = full_package_name.split('-')[0]
            package_build_time = extract_package_build_time(full_package_name)

            if package_build_time > datetime(2023,1,1):
                to_hide.add(obj)
                continue

            # Hard pass on packages that are included in our allow list
            if package_name not in PACKAGE_ALLOW_LIST:
                to_hide.add(obj)
                continue
            packages[package_name] += 1

        s3Objects = list(set(self.objects).difference({
            obj for obj in self.objects
            if self.normalize_package_version(obj) in to_hide
        }))


        package_name_version: Dict[str, List[str]] = defaultdict(List[str])
        for obj in s3Objects:
            full_package_name = path.basename(obj.key)
            package_name = full_package_name.split('-')[0]

            name_ver = self.normalize_package_version(obj)
            version = safe_parse_version(name_ver.split('-', 1)[-1])
            base_version = version.base_version
            dict_key = f"{package_name}-{base_version}"

            if dict_key in package_name_version:
                package_name_version[dict_key].append(name_ver)
            else:
                package_name_version.setdefault(dict_key, list())
                package_name_version[dict_key].append(name_ver)

        versions_to_move: Set[str] = set()
        for key in package_name_version.keys():
            package_name_version[key] = sorted(package_name_version[key], reverse = True)
            if len(package_name_version[key]) > 20:
                versions_to_move.update(package_name_version[key][20:])

        return list(obj for obj in s3Objects
            if self.normalize_package_version(obj) in versions_to_move)


    def normalize_package_version(self: S3IndexType, obj: S3Object) -> str:
        # removes the GPU specifier from the package name as well as
        # unnecessary things like the file extension, architecture name, etc.
        return sub(
            r"%2B.*",
            "",
            "-".join(path.basename(obj.key).split("-")[:2])
        )


    @classmethod
    def fetch_object_names(cls: Type[S3IndexType], prefix: str) -> List[str]:
        obj_names = []
        for obj in BUCKET.objects.filter(Prefix=prefix):
            is_acceptable = any([path.dirname(obj.key) == prefix] + [
                match(
                    f"{prefix}/{pattern}",
                    path.dirname(obj.key)
                )
                for pattern in ACCEPTED_SUBDIR_PATTERNS
            ]) and obj.key.endswith(ACCEPTED_FILE_EXTENSIONS)
            if not is_acceptable:
                continue
            
            obj_names.append(obj.key)
        return obj_names


    @classmethod
    def from_S3(cls: Type[S3IndexType], prefix: str, with_metadata: bool = True) -> S3IndexType:
        prefix = prefix.rstrip("/")
        obj_names = cls.fetch_object_names(prefix)

        def sanitize_key(key: str) -> str:
            return key.replace("+", "%2B")

        rc = cls([S3Object(key=sanitize_key(key),
                           orig_key=key,
                           checksum=None,
                           size=None) for key in obj_names], prefix)
        if prefix == "whl/nightly":
            rc.objects = rc.nightly_packages_to_move()

        return rc

def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser("Archive PyTorch wheels")
    parser.add_argument(
        "prefix",
        type=str,
        choices=PREFIXES + ["all"]
    )
    return parser


def main() -> None:
    parser = create_parser()
    args = parser.parse_args()

    prefixes = PREFIXES if args.prefix == 'all' else [args.prefix]
    for prefix in prefixes:
        generate_pep503 = prefix.startswith("whl")
        print(f"INFO: Archiving for '{prefix}'")
        stime = time.time()
        idx = S3Index.from_S3(prefix=prefix)
        etime = time.time()
        print(f"DEBUG: Fetched {len(idx.objects)} objects for '{prefix}' in {etime-stime:.2f} seconds")

        for obj in idx.objects:
            CLIENT.copy_object(
                Bucket="pytorch", 
                CopySource=f"{path.dirname(obj.key)}/{path.basename(obj.key)}",
                Key=f"nightly-archive/{path.dirname(obj.key)}/{path.basename(obj.key)}")

            CLIENT.delete_object(Bucket="pytorch", Key=f"{path.dirname(obj.key)}/{path.basename(obj.key)}")
            print(f"Archived: {path.dirname(obj.key)}/{path.basename(obj.key)}")
        
  

if __name__ == "__main__":
    main()
