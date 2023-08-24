import argparse
import datetime
import gzip
import io
import json
import os
from typing import Any, Dict, List

import boto3  # type: ignore[import]
import rockset  # type: ignore[import]

S3_RESOURCE = boto3.resource("s3")
RELEVANT_QUERIES_VERSION = "727014a49bef2c20"


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


def get_recent_alerts(orgname, reponame):
    rockset_api_key = os.environ["ROCKSET_API_KEY"]
    rockset_api_server = "api.rs2.usw2.rockset.com"
    rs = rockset.RocksetClient(host="api.usw2a1.rockset.com", api_key=rockset_api_key)

    # Define the name of the Rockset collection and lambda function
    collection_name = "commons"
    lambda_function_name = "get_relevant_alerts"
    query_parameters = [
        rockset.models.QueryParameter(name="repo", type="string", value=reponame),
        rockset.models.QueryParameter(
            name="organization", type="string", value=orgname
        ),
    ]
    api_response = rs.QueryLambdas.execute_query_lambda(
        query_lambda=lambda_function_name,
        workspace=collection_name,
        version=RELEVANT_QUERIES_VERSION,
        parameters=query_parameters,
    )
    return api_response["results"]


def merge_alerts(old_alerts, new_alerts):
    merged_alerts = []
    current_alert_keys = set()
    for alert in new_alerts:
        key = (alert["AlertObject"], alert["AlertType"])
        current_alert_keys.add(key)
        merged_alerts.append(alert)
    for alert in old_alerts:
        key = (alert["AlertObject"], alert["AlertType"])
        if key not in current_alert_keys and not alert["closed"]:
            alert["closed"] = True
            merged_alerts.append(alert)
    return merged_alerts


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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Upload json string containing alerts to AWS"
    )
    parser.add_argument(
        "--alerts", type=str, required=True, help="JSON string to validate."
    )
    parser.add_argument(
        "--org", type=str, required=True, help="Organization of repository for alerts"
    )
    parser.add_argument("--repo", type=str, required=True, help="Repository for alerts")
    args = parser.parse_args()
    timestamp = datetime.datetime.utcnow().isoformat()
    new_alerts = append_metadata(args.alerts, args.org, args.repo, timestamp)
    old_alerts = get_recent_alerts(args.org, args.repo)
    data = merge_alerts(old_alerts, new_alerts)
    upload_to_s3(
        bucket_name="torchci-alerts",
        key=f"alerts/{args.org}/{args.repo}/{str(timestamp)}",
        docs=data,
    )
