"""Kick off log classification when a job log lands in S3.

Wired to `s3:ObjectCreated:*` on the `log/` prefix of `ossci-raw-job-status`, so
whatever put the log there -- gha-log-uploader, torchci's backfill route, or a
person running `aws s3 cp` -- gets it classified. Decoupling this from the
uploader is what keeps a slow classification from showing up as uploader latency.

`log_classifier` is reached through `lambda:InvokeFunction` rather than its public
function URL. It is built on lambda_http with only the `apigw_http` feature, so it
expects an API Gateway HTTP API v2.0 request; PAYLOAD_TEMPLATE reproduces that
shape. Verified against the deployed function: a payload with no `job_id` returns
its 400 "no job id provided" branch, and a non-numeric one fails in its
`parse::<usize>()`, which together show both the envelope and the query string
are read.

Sibling `keep-going-call-log-classifier` does the same job for the `temp_logs/`
prefix on `gha-artifacts`. The two should be folded together once the
github-status-test cutover is finished.
"""

import json
from typing import Any, Optional, Tuple

import boto3


LOG_CLASSIFIER_FUNCTION = "log_classifier"
DEFAULT_REPO = "pytorch/pytorch"
LOG_PREFIX = "log/"

lambda_client = boto3.client("lambda")


def parse_key(key: str) -> Optional[Tuple[str, int]]:
    """Map an S3 key under `log/` to (repo, job_id), or None if it isn't one.

    pytorch/pytorch is unprefixed for historical reasons, so `log/<id>` means
    pytorch/pytorch and `log/<owner>/<repo>/<id>` names its repo explicitly.
    """
    if not key.startswith(LOG_PREFIX):
        return None

    parts = key[len(LOG_PREFIX) :].split("/")
    if len(parts) == 1:
        repo = DEFAULT_REPO
    elif len(parts) == 3:
        repo = f"{parts[0]}/{parts[1]}"
    else:
        # Neither shape. Includes `log/<owner>/<id>` and anything deeper, which
        # we have no way to attribute to a repo.
        return None

    try:
        return repo, int(parts[-1])
    except ValueError:
        return None


def classifier_payload(repo: str, job_id: int) -> dict:
    """An API Gateway HTTP API v2.0 request, which is what lambda_http parses."""
    query = {"job_id": str(job_id), "repo": repo}
    return {
        "version": "2.0",
        "routeKey": "$default",
        "rawPath": "/",
        "rawQueryString": f"job_id={job_id}&repo={repo}",
        "headers": {},
        "queryStringParameters": query,
        "requestContext": {
            "accountId": "308535385114",
            "apiId": "call-log-classifier",
            "domainName": "lambda-invoke",
            "domainPrefix": "lambda-invoke",
            "http": {
                "method": "GET",
                "path": "/",
                "protocol": "HTTP/1.1",
                "sourceIp": "127.0.0.1",
                "userAgent": "call-log-classifier",
            },
            "requestId": f"call-log-classifier-{job_id}",
            "routeKey": "$default",
            "stage": "$default",
            "time": "01/Jan/1970:00:00:00 +0000",
            "timeEpoch": 0,
        },
        "isBase64Encoded": False,
    }


def lambda_handler(event: Any, context: Any) -> None:
    for record in event.get("Records", []):
        key = record.get("s3", {}).get("object", {}).get("key", "")

        parsed = parse_key(key)
        if parsed is None:
            print(f"Skipping key that isn't a job log: key={key}")
            continue

        repo, job_id = parsed
        try:
            # Async: classification can take minutes and nothing here reads the
            # result, so blocking on it would only burn this function's runtime.
            lambda_client.invoke(
                FunctionName=LOG_CLASSIFIER_FUNCTION,
                InvocationType="Event",
                Payload=json.dumps(classifier_payload(repo, job_id)).encode(),
            )
        except Exception as error:
            # One bad key must not strand the rest of the batch.
            print(
                f"Failed to call log classifier for job_id={job_id}, "
                f"repo={repo}, key={key}, error={error}"
            )
