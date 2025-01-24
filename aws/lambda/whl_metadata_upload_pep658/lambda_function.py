import os
import zipfile
from functools import cache
from typing import Any
from urllib.parse import unquote

import boto3  # type: ignore[import-not-found]
from botocore import UNSIGNED # type: ignore[import-not-found]
from botocore.config import Config # type: ignore[import-not-found]


@cache
def get_client(read_only: bool) -> Any:
    if read_only:
        return boto3.client("s3", config=Config(signature_version=UNSIGNED))
    return boto3.client("s3")


def upload_s3(bucket: str, key: str, filename: str, dry_run: bool) -> None:
    print(f"Uploading to {bucket}/{key}")
    if not dry_run:
        get_client(False).upload_file(
            filename,
            bucket,
            key,
            ExtraArgs={"ChecksumAlgorithm": "sha256", "ACL": "public-read"},
        )


def lambda_handler(event: Any, context: Any, dry_run: bool = False) -> None:
    zip_location = "/tmp/wheel.zip"
    metadata_location = "/tmp/METADATA"
    for record in event["Records"]:
        bucket = record["s3"]["bucket"]["name"]
        key = unquote(record["s3"]["object"]["key"])
        if not key.endswith(".whl"):
            print(f"Skipping {bucket}/{key} as it is not a wheel")
            continue
        print(f"Processing {bucket}/{key}")

        if os.path.exists(zip_location):
            os.remove(zip_location)

        get_client(dry_run).download_file(bucket, key, zip_location)

        if os.path.exists(metadata_location):
            os.remove(metadata_location)

        with zipfile.ZipFile(zip_location, "r") as zip_ref:
            for filename in zip_ref.infolist():
                if filename.filename.endswith(".dist-info/METADATA"):
                    filename.filename = "METADATA"
                    zip_ref.extract(filename, "/tmp")
                    upload_s3(bucket, f"{key}.metadata", metadata_location, dry_run)
                    break
