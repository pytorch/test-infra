import asyncio
import json
import os
import warnings
from json.decoder import JSONDecodeError
from typing import Any, Dict
from urllib.parse import quote

import aioboto3

URL_PREFIX = "https://gha-artifacts.s3.amazonaws.com"
GHA_ARTIFACTS_BUCKET = "gha-artifacts"
DEFAULT_REPO = "pytorch/pytorch"
SESSION = aioboto3.Session()


async def list_objects(repo: str, workflow_id: str) -> Dict[str, int]:
    async with SESSION.resource("s3") as s3:
        bucket = await s3.Bucket(GHA_ARTIFACTS_BUCKET)

        artifacts = {}
        async for s3_object in bucket.objects.filter(Prefix=f"{repo}/{workflow_id}"):
            if not s3_object.key:
                continue

            size = await s3_object.size

            artifact = "/".join([quote(v) for v in s3_object.key.split("/")])
            artifacts[f"{URL_PREFIX}/{artifact}"] = size

        return artifacts


def lambda_handler(event: Any, context: Any) -> None:
    """
    The input of the lambda is the ID of the workflow where we want to list its
    artifacts, i.e. {"workflow_id": "123456"}

    The repository is optional and default to pytorch/pytorch, i.e.
    {
        "workflow_id": "123456",
        "repo": "pytorch/pytorch",
    }

    This returns the dictionary of all artifacts from the workflow together with
    their size in byte, keyed by their public links
    """
    body = event.get("body", "")
    if not body:
        return {}

    try:
        params = json.loads(body)
    except JSONDecodeError as error:
        warnings.warn(f"Failed to parse request body {body}: {error}")
        return {}

    repo = params.get("repo", DEFAULT_REPO)
    workflow_id = params.get("workflow_id", "")
    if not workflow_id:
        return {}

    print(f"Listing artifact for workflow {workflow_id} from {repo}")
    return asyncio.run(list_objects(repo, workflow_id))


if os.getenv("DEBUG", "0") == "1":
    mock_body = {"workflow_id": "7392058557"}
    print(
        lambda_handler(
            {"body": json.dumps(mock_body)},
            None,
        )
    )
