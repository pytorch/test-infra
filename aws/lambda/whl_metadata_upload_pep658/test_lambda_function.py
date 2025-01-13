import argparse
import json
import os
from pathlib import Path
from typing import Generator

from lambda_function import get_client, lambda_handler

GENERATE_EVENT_HELP_TEXT = """
Generate an test_event.json for all files in this s3 path and test the lambda
function with this new test_event.json. The test_event.json does not have
complete data, only known attributes that are needed for the lambda function.
Format should be `<bucket>/<key prefix>`, ex `pytorch/whl/nightly`.  Note that
you will need more permissions to list objects in the bucket.
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    # Default to dry run (not uploading)
    parser.add_argument("--no-dry-run", action="store_true")
    parser.add_argument(
        "--generate-event",
        metavar="BUCKET/KEY_PREFIX",
        type=str,
        help=GENERATE_EVENT_HELP_TEXT,
    )
    return parser.parse_args()


def get_all_keys(bucket: str, key_prefix: str) -> Generator[str, None, None]:
    paginator = get_client(False).get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=key_prefix):
        for obj in page["Contents"]:
            if obj["Key"].endswith(".whl"):
                yield obj["Key"]


if __name__ == "__main__":
    args = parse_args()
    test_file = Path(__file__).parent / "test_event.json"

    with open(test_file) as f:
        event = json.load(f)
    if args.generate_event:
        bucket = args.generate_event.split("/")[0]
        key = args.generate_event[len(bucket) + 1 :]

        event["Records"] = [
            {
                "s3": {
                    "bucket": {"name": bucket},
                    "object": {"key": key},
                }
            }
            for key in get_all_keys(bucket, key)
        ]
        json.dump(event, open(test_file, "w"), indent=2)

    lambda_handler(event, None, dry_run=not args.no_dry_run)
