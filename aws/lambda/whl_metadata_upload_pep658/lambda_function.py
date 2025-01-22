import os
import zipfile
from functools import cache
from typing import Any
from urllib.parse import unquote

import boto3  # type: ignore[import]
from botocore import UNSIGNED
from botocore.config import Config


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


def reupload_s3(bucket: str, key: str, dry_run: bool) -> None:
    print(f"Reuploading {bucket}/{key} with checksum")
    if not dry_run:
        get_client(dry_run).copy_object(
            ACL="public-read",
            Bucket=bucket,
            Key=key,
            CopySource={"Bucket": bucket, "Key": key},
            MetadataDirective="REPLACE",
            ChecksumAlgorithm="SHA256",
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

        # Check if the binary has a checksum and reupload with a checksum if it
        # doesn't. This is for pep503. This will retrigger the lambda, so it
        # will return if it uploads and assume the next run of the lambda will
        # handle the pep658 metadata upload.
        if (
            get_client(dry_run)
            .head_object(Bucket=bucket, Key=key, ChecksumMode="ENABLED")
            .get("ChecksumSHA256")
            is not None
        ):
            print(f"Checksum already exists for {bucket}/{key}")
        else:
            reupload_s3(bucket, key, dry_run)
            return

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
