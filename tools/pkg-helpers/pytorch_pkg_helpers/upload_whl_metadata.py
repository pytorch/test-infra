# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "boto3",
# ]
# ///
import argparse
import os
import shutil
import zipfile
from functools import cache
from pathlib import Path
from typing import Any, Optional

import boto3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upload metadata file to S3")
    parser.add_argument(
        "--package", type=str, required=True, help="Path to the package"
    )
    parser.add_argument(
        "--s3-path",
        type=str,
        required=True,
        help="S3 key to upload metadata file to",
    )
    parser.add_argument("--dry-run", action="store_true", help="Dry run")
    args = parser.parse_args()
    # Sanitize the input a bit by removing s3:// prefix + trailing/leading
    # slashes
    if args.s3_path.startswith("s3://"):
        args.s3_path = args.s3_path[5:]
    args.s3_path = args.s3_path.strip("/")
    return args


@cache
def get_s3_client() -> Any:
    return boto3.client("s3")


def s3_upload(s3_bucket: str, s3_key: str, file: str, dry_run: bool) -> None:
    s3 = get_s3_client()
    if dry_run:
        print(f"Dry run uploading {file} to s3://{s3_bucket}/{s3_key}")
        return
    s3.upload_file(
        file,
        s3_bucket,
        s3_key,
        ExtraArgs={"ChecksumAlgorithm": "sha256", "ACL": "public-read"},
    )


def extract_metadata(file: str) -> Optional[str]:
    # Copy the file to a temp location to extract the METADATA file
    file_name = Path(file).name
    tmp = "/tmp"
    shutil.copy(file, tmp)
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


if __name__ == "__main__":
    # https://peps.python.org/pep-0658/
    # Upload the METADATA file to S3
    args = parse_args()
    if Path(args.package).suffix != ".whl":
        print("Invalid package file, must be a .whl file")
        exit(0)

    metadata_file = extract_metadata(args.package)
    if metadata_file is None:
        # Highly unlikely but just in case
        print("Failed to extract METADATA file from wheel")
        exit(0)

    bucket = args.s3_path.split("/")[0]
    key = "/".join(args.s3_path.split("/")[1:]) + f"/{Path(args.package).name}.metadata"
    s3_upload(
        bucket,
        key,
        metadata_file,
        args.dry_run,
    )
