from typing import Any
from urllib.error import HTTPError
from urllib.request import urlopen

LOG_CLASSIFIER_URL = "https://vwg52br27lx5oymv4ouejwf4re0akoeg.lambda-url.us-east-1.on.aws/"
PYTORCH_REPO = "pytorch/pytorch"

def lambda_handler(event: Any, context: Any) -> None:
    # Entry point for the lambda function
    for record in event["Records"]:
        key = record["s3"]["object"]["key"]
        job_id = key.split("/")[-1]
        try:
            job_id = int(job_id)
        except ValueError:
            print(f"Failed to convert job id into int job_id={job_id}, key={key}")
            continue
        try:
            urlopen(
                f"{LOG_CLASSIFIER_URL}?job_id={job_id}&repo={PYTORCH_REPO}&temp_log=true"
            )
        except HTTPError as e:
            print(f"Failed to call log classifier for job_id={job_id}, key={key}, error={e}")
