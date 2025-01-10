import boto3
from functools import cache
import os
import zipfile
from urllib.parse import unquote


@cache
def get_client():
    return boto3.client("s3")


def upload_s3(bucket, key, filename, dry_run):
    print(f"Uploading to {bucket}/{key}")
    if not dry_run:
        get_client().upload_file(
            filename,
            bucket,
            key,
            ExtraArgs={"ChecksumAlgorithm": "sha256", "ACL": "public-read"},
        )


def lambda_handler(event, context, dry_run=False):
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

        get_client().download_file(bucket, key, zip_location)

        if os.path.exists(metadata_location):
            os.remove(metadata_location)

        with zipfile.ZipFile(zip_location, "r") as zip_ref:
            for filename in zip_ref.infolist():
                if filename.filename.endswith(".dist-info/METADATA"):
                    filename.filename = "METADATA"
                    zip_ref.extract(filename, "/tmp")
                    upload_s3(bucket, f"{key}.metadata", metadata_location, dry_run)
                    break
