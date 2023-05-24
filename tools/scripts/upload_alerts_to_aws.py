import datetime
import boto3
import json
import argparse
import gzip
import io
import json
import os
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any, Dict, List

import boto3  # type: ignore[import]
import requests
import rockset  # type: ignore[import]

S3_RESOURCE = boto3.resource("s3")
def upload_to_s3(
    bucket_name: str,
    key: str,
    docs: List[Dict[str, Any]],
) -> None:
    print(f"Writing {len(docs)} documents to S3")
    body = io.StringIO()
    for doc in docs:
        json.dump(doc, body)
        body.write("\n")

    S3_RESOURCE.Object(
        f"{bucket_name}",
        f"{key}",
    ).put(
        Body=gzip.compress(body.getvalue().encode()),
        ContentEncoding="gzip",
        ContentType="application/json",
    )
    print("Done!")

def append_metadata(json_string, org_name, repo_name, timestamp):
    # Load the JSON string into a Python object
    data = json.loads(json_string)

    # Iterate over each object in the array and add the new property
    for obj in data:
        obj["organization"] = org_name
        obj["repo"] = repo_name
        obj["closed"] = False
        obj["timestamp"] = timestamp
    
    return data

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Upload json string containing alerts to AWS")
    parser.add_argument('--alerts', type=str, required=True, help="JSON string to validate.")
    parser.add_argument('--repo', type=str, required=True, help="Organization of repository for alerts")
    parser.add_argument('--repo', type=str, required=True, help="Repository for alerts")
    args = parser.parse_args()
    timestamp = datetime.datetime.now().isoformat()
    data = append_metadata(args.alerts, args.org, args.repo, timestamp)
    upload_to_s3(        
        bucket_name="torchci-alerts",
        key=f"test_alerts/{str(timestamp)}",
        docs= data)

