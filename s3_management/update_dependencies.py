from typing import Dict, List

import boto3

S3 = boto3.resource("s3")
CLIENT = boto3.client("s3")
BUCKET = S3.Bucket("pytorch")

PACKAGES = [
    "sympy",
    "mpmath",
    "pillow",
    "networkx",
    "numpy",
    "jinja2",
    "filelock",
    "fsspec",
    "nvidia-cudnn-cu11",
    "nvidia-cudnn-cu12",
    "typing-extensions",
]


def download(url: str) -> bytes:
    from urllib.request import urlopen

    with urlopen(url) as conn:
        return conn.read()


def parse_simple_idx(url: str) -> Dict[str, str]:
    import re

    html = download(url).decode("ascii")
    return {
        name: url
        for (url, name) in re.findall('<a href="([^"]+)"[^>]*>([^>]+)</a>', html)
    }


def get_whl_versions(idx: Dict[str, str]) -> List[str]:
    return [k.split("-")[1] for k in idx.keys() if k.endswith(".whl")]


def get_wheels_of_version(idx: Dict[str, str], version: str) -> Dict[str, str]:
    return {
        k: v
        for (k, v) in idx.items()
        if k.endswith(".whl") and k.split("-")[1] == version
    }


def upload_missing_whls(
    pkg_name: str = "numpy", prefix="whl/test", *, dry_run: bool = False
) -> None:
    pypi_idx = parse_simple_idx(f"https://pypi.org/simple/{pkg_name}")
    download_idx = parse_simple_idx(f"https://download.pytorch.org/{prefix}/{pkg_name}")
    pypi_versions = get_whl_versions(pypi_idx)
    pypi_latest_packages = get_wheels_of_version(pypi_idx, pypi_versions[-1])
    downlod_latest_packages = get_wheels_of_version(download_idx, pypi_versions[-1])
    has_updates = False
    for pkg in pypi_latest_packages:
        if pkg in downlod_latest_packages:
            continue
        # Skip pp packages
        if "-pp3" in pkg:
            continue
        # Skip win32 packages
        if "-win32" in pkg:
            continue
        # Skip muslinux packages
        if "-musllinux" in pkg:
            continue
        print(f"Downloading {pkg}")
        if dry_run:
            has_updates = True
            continue
        data = download(pypi_idx[pkg])
        print(f"Uplodating {pkg} to s3://pytorch/{prefix}/")
        BUCKET.Object(key=f"{prefix}/{pkg}").put(
            ACL="public-read", ContentType="binary/octet-stream", Body=data
        )
        has_updates = True
    if not has_updates:
        print(
            f"{pkg_name} is already at latest version {pypi_versions[-1]} for {prefix}"
        )


def main() -> None:
    from argparse import ArgumentParser

    parser = ArgumentParser("Upload dependent packages to s3://pytorch")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--include-stable", action="store_true")
    args = parser.parse_args()

    SUBFOLDERS = ["whl/nightly", "whl/test"]
    if args.include_stable:
        SUBFOLDERS.append("whl")

    for prefix in SUBFOLDERS:
        for package in PACKAGES:
            upload_missing_whls(package, prefix, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
