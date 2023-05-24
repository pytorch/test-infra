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

def get_recent_alerts(orgname, reponame):
    rockset_api_key = os.environ["ROCKSET_API_KEY"]
    rockset_api_server = "api.rs2.usw2.rockset.com"
    iso_date = datetime.date.isoformat()
    rs = rockset.RocksetClient(
        host="api.usw2a1.rockset.com", api_key=os.environ["ROCKSET_API_KEY"]
    )

    # Define the name of the Rockset collection and lambda function
    collection_name = "commons"
    lambda_function_name = "get_recent_alerts"
    query_parameters = [
        rockset.models.QueryParameter(name="repo", type="string", value=reponame),
        rockset.models.QueryParameter(name="org", type="string", value=orgname),
    ]
    api_response = rs.QueryLambdas.execute_query_lambda(
        query_lambda=lambda_function_name,
        version="692684fa5b37177f",
        parameters=query_parameters,
    )
    for i in range(len(api_response["results"])):
        oncalls = get_oncall_from_testfile(api_response["results"][i]["test_file"])
        api_response["results"][i]["oncalls"] = oncalls
    return json.loads(
        json.dumps(api_response["results"], indent=4, sort_keys=True, default=str)
    )

def merge_alerts(current_alerts, new_alerts):
    current_alert_keys = set()
    for alert in current_alerts:
        key = (alert["AlertObject"], alert["AlertType"])
        current_alert_keys.add(key)
    for alert in new_alerts:
        key = (alert["AlertObject"], alert["AlertType"])
        if key not in current_alert_keys:
            alert["closed"] = True
            current_alerts.append(alert)
    return current_alerts


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
    new_alerts = append_metadata(args.alerts, args.org, args.repo, timestamp)
    current_alerts = get_recent_alerts(args.org, args.repo)
    data = merge_alerts(current_alerts, new_alerts)
    upload_to_s3(        
        bucket_name="torchci-alerts",
        key=f"test_alerts/{str(timestamp)}",
        docs= data)

