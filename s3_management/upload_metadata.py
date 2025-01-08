#!/usr/bin/env -S uv run —verbose
# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "boto3",
# ]
# ///
import argparse
from datetime import datetime
import os
import shutil
import zipfile
from functools import cache
from pathlib import Path
from typing import Any, Optional

import boto3

BUCKET = "pytorch"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Upload metadata file to S3 if they are not present"
    )
    parser.add_argument(
        "--prefix",
        type=str,
        required=True,
        help="S3 key to filter while whls to upload metadata for",
    )
    parser.add_argument(
        "--past-day",
        action="store_true",
        help="Only look at packages modified in the past day",
    )
    parser.add_argument("--dry-run", action="store_true", help="Dry run")
    args = parser.parse_args()
    return args


@cache
def get_s3_client() -> Any:
    return boto3.client("s3")


def s3_upload(s3_bucket: str, s3_key: str, file: str, dry_run: bool) -> None:
    s3 = get_s3_client()
    if dry_run:
        print(f"Dry run uploading {file} to s3://{s3_bucket}/{s3_key}")
        return
    print(f"Uploading {file} to s3://{s3_bucket}/{s3_key}")
    s3.upload_file(
        file,
        s3_bucket,
        s3_key,
        ExtraArgs={"ChecksumAlgorithm": "sha256", "ACL": "public-read"},
    )


def copy_to_tmp(file: str) -> str:
    # Copy file with path a/b/c.d to /tmp/c.d
    file_name = Path(file).name
    tmp = "/tmp"
    shutil.copy(file, tmp)
    return f"{tmp}/{file_name}"


def extract_metadata(file: str) -> Optional[str]:
    # Extract the METADATA file from the wheel. With input file a/b/c.whl, tmp
    # is expected to have /tmp/c.whl, which gets converted to /tmp/c.zip, and
    # the METADATA file is extracted to /tmp/METADATA
    file_name = Path(file).name
    tmp = "/tmp"
    zip_file = f"{tmp}/{file_name.replace('.whl', '.zip')}"
    shutil.move(f"{tmp}/{file_name}", zip_file)

    if os.path.exists(f"{tmp}/METADATA"):
        os.remove(f"{tmp}/METADATA")

    with zipfile.ZipFile(zip_file, "r") as zip_ref:
        for filename in zip_ref.infolist():
            if filename.filename.endswith(".dist-info/METADATA"):
                filename.filename = "METADATA"
                zip_ref.extract(filename, tmp)
                return f"{tmp}/METADATA"
    return None


def download_package_from_s3(bucket: str, key_prefix: str, file: str) -> str:
    # Download the package from S3 to /tmp.  With input bucket a, key_prefix b,
    # and file c.d, the file located at s3://a/b/c.d is downloaded to /tmp/c.d
    s3 = get_s3_client()
    local_file = f"/tmp/{file}"
    s3.download_file(bucket, f"{key_prefix}/{file}", local_file)
    return local_file


def upload_metadata_in_prefix(
    bucket: str, prefix: str, past_day: bool, dry_run: bool
) -> None:
    # For all whls in the prefix, upload the metadata file to S3 if the metadata
    # is not present
    s3_paginator = get_s3_client().get_paginator("list_objects_v2")
    all_files = []
    for page in s3_paginator.paginate(Bucket=bucket, Prefix=prefix):
        all_files.extend(page["Contents"])

    DAY_SECONDS = 24 * 60 * 60
    whls = [
        file["Key"]
        for file in all_files
        if file["Key"].endswith(".whl")
        and (
            not past_day
            or datetime.now().timestamp() - file["LastModified"].timestamp()
            < DAY_SECONDS
        )
    ]
    metadatas = set(
        file["Key"] for file in all_files if file["Key"].endswith(".metadata")
    )

    for whl in whls:
        if not f"{whl}.metadata" in metadatas:
            _prefix = "/".join(whl.split("/")[:-1])
            _key = whl.split("/")[-1]
            local_file = download_package_from_s3(bucket, _prefix, _key)
            metadata_file = extract_metadata(local_file)
            if not metadata_file:
                print(f"Failed to extract metadata from {whl}")
                continue
            s3_upload(bucket, f"{whl}.metadata", metadata_file, dry_run)


if __name__ == "__main__":
    # https://peps.python.org/pep-0658/
    args = parse_args()
    upload_metadata_in_prefix(BUCKET, args.prefix, args.past_day, args.dry_run)
