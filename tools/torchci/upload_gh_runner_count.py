import argparse
import gzip
import io
import json
import re
import time
from typing import Any, Optional

import boto3
import requests


S3_RESOURCE = boto3.resource("s3")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upload GitHub runner count to S3")
    parser.add_argument(
        "--upload",
        action="store_true",
        help="Upload the GitHub runner count to S3",
    )
    parser.add_argument(
        "--github-token",
        type=str,
        required=True,
        help="This requires a token with org level admin permissions in order to list runners",
    )
    return parser.parse_args()


LINK_HEADER_REGEX = r'<([^>]+)>;\s*rel="([^"]+)"'


def parse_link_header(link_header: Optional[str]) -> dict[str, str]:
    links = {}
    if not link_header:
        return links
    parts = link_header.split(",")
    for part in parts:
        match = re.match(LINK_HEADER_REGEX, part.strip())
        if match:
            url, rel = match.groups()
            links[rel] = url
    return links


def get_gh_runners(args: argparse.Namespace) -> list[dict[str, Any]]:
    url: Optional[str] = "https://api.github.com/orgs/pytorch/actions/runners"
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "Authorization": f"Bearer {args.github_token}",
    }

    runners = []
    while url is not None:
        response = requests.get(url, headers=headers, params={"per_page": 100})
        if response.status_code != 200:
            raise Exception(
                f"Failed to fetch runners: {response.status_code} {response.text}"
            )
        data = response.json()
        if len(data["runners"]) == 0:
            break
        runners.extend(data["runners"])
        url = parse_link_header(response.headers.get("Link")).get("next")

    return runners


def upload_to_s3(timestamp: int, data: list[dict[str, Any]]) -> None:
    body = io.StringIO()
    for runner in data:
        json.dump(runner, body)
        body.write("\n")
    S3_RESOURCE.Object(
        f"ossci-raw-job-status", f"pytorch_org_gh_runners/{timestamp}.gzip"
    ).put(
        Body=gzip.compress(body.getvalue().encode()),
        ContentEncoding="gzip",
        ContentType="application/json",
    )


def main() -> None:
    args = parse_args()
    runners = get_gh_runners(args)
    # Labels take the form {id, name, type} but we only really care about the name
    for runner in runners:
        runner["labels"] = [label["name"] for label in runner["labels"]]

    if args.upload:
        # Add a timestamp to the runners for tracking
        timestamp = int(time.time())
        for runner in runners:
            runner["timestamp"] = timestamp
        upload_to_s3(timestamp, runners)
    else:
        print(json.dumps(runners, indent=2))


if __name__ == "__main__":
    main()
