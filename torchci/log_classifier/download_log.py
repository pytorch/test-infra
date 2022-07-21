"""
download_log.py

Given an GitHub workflow job id or set of ids,
- Retrieve the logs from GitHub.
- Compress the logs
- Write them to s3.
"""

import os
from uuid import uuid4
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import boto3  # type: ignore

import gzip


s3 = boto3.resource("s3")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
BUCKET_NAME = "ossci-raw-job-status"


def download_log(conclusion, id):
    url = f"https://api.github.com/repos/pytorch/pytorch/actions/jobs/{id}/logs"
    headers = {"Accept": "application/vnd.github.v3+json"}
    headers["Authorization"] = f"token {GITHUB_TOKEN}"
    with urlopen(Request(url, headers=headers)) as data:
        log_data = data.read()
    s3.Object(BUCKET_NAME, f"log/{id}").put(
        Body=gzip.compress(log_data),
        ContentType="text/plain",
        ContentEncoding="gzip",
        Metadata={"conclusion": conclusion},
    )


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "ids",
        nargs="+",
        help="ids to download",
    )

    args = parser.parse_args()
    for id in args.ids:
        print(f"downloading job {id}")
        download_log("failure", id)
