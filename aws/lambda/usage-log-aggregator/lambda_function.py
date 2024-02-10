"""
Aggregate usage logs on S3 GHA artifacts bucket for fun and profit!
"""
import asyncio
import io

from warnings import warn
import json
import os
import re
import zipfile
from json import JSONDecodeError
from typing import Any, AsyncGenerator, Dict, List, Tuple

import pandas as pd
from aiobotocore.session import get_session

ARTIFACTS_S3_BUCKET = "gha-artifacts"
USAGE_LOG_FILENAME = "usage_log.txt"
PYTORCH = "pytorch"
MAX_ARTIFACTS = 50
JOB_NAME_REGEX = re.compile(
    r"^(?P<job>.+)\s/\s.+\((?P<s_name>[^,]+),\s(?P<s_id>[^,]+),\s(?P<s_count>[^,]+),\s(?P<platform>[^,]+)\)$"
)
# One minute according to the rule https://pandas.pydata.org/docs/reference/api/pandas.Series.resample.html
RESAMPLING_WINDOW = "1T"
DATETIME_FORMAT = "%Y-%m-%d %X"
# NB: This is a work around to handle the case where requested job is retried
MAX_RUN_ATTEMPT_TO_SCAN = 10


async def get_usage_log(
    s3_client: any,
    owner: str,
    repo: str,
    prefix: str,
    workflow_ids: List[str],
    job_ids: List[str],
) -> AsyncGenerator:
    """
    Get the usage log. The key is as follows OWNER/REPO/WORKFLOW_ID/RUN_ATTEMPT/artifact/PREFIX_JOB_ID.zip, for
    example pytorch/pytorch/3154788075/1/artifact/usage-log-test-distributed-1-2-linux.2xlarge_8628515238.zip
    """
    for i in range(len(workflow_ids)):
        workflow_id = workflow_ids[i]
        job_id = job_ids[i]

        content = {}
        for run_attempt in range(1, MAX_RUN_ATTEMPT_TO_SCAN):
            s3_path = (
                f"{owner}/{repo}/{workflow_id}/{run_attempt}/artifact/{prefix}_{job_id}.zip"
            )
            print(f"Checking {s3_path}")

            try:
                content = await s3_client.get_object(
                    Bucket=ARTIFACTS_S3_BUCKET, Key=s3_path
                )
            except s3_client.exceptions.NoSuchKey as error:
                warn(f"Fail to find the artifact at {s3_path}: {error}")
                continue

            if content:
                break

        if not content:
            yield workflow_id, job_id, ""
        else:
            try:
                zip_data = await content["Body"].read()
                with zipfile.ZipFile(io.BytesIO(zip_data)) as z:
                    yield workflow_id, job_id, z.read(name=USAGE_LOG_FILENAME).decode()
            except Exception as error:
                warn(f"Fail to extract the usage log from {s3_path}: {error}")
                yield workflow_id, job_id, ""


async def _get_usage_log_prefix(job_name: str) -> str:
    """
    Generate the usage log prefix from the job name. The current naming is as follows
    usage-log-test-SHARD_NAME-SHARD_ID-SHARD_COUNT-PLATFORM_, i.e. usage-log-test-distributed-2-2-linux.2xlarge
    """
    m = JOB_NAME_REGEX.match(job_name)
    if not m:
        return ""

    shard_name = m.group("s_name")
    shard_id = m.group("s_id")
    shard_count = m.group("s_count")
    platform = m.group("platform")

    return f"logs-test-{shard_name}-{shard_id}-{shard_count}-{platform}"


async def _process_raw_logs(raw_logs: List[Tuple[str, str, str]]) -> Dict[str, str]:
    """
    Parse and process raw usage logs from different jobs
    """
    timestamps = []
    jobs = {}
    total_cpu_percent = []
    total_mem_usage = []
    total_gpu_utilization = []
    total_gpu_mem_usage = []

    for workflow_id, job_id, usage_log in raw_logs:
        start_time = 0
        stop_time = 0

        for line in usage_log.splitlines():
            try:
                datapoint = json.loads(line)
            except json.decoder.JSONDecodeError as error:
                # This is to handle invalid lines on the log, it's ok to ingore them
                warn(f"Failed to load {line}: {error}")
                continue

            if (
                "time" not in datapoint
                or "total_cpu_percent" not in datapoint
                or "per_process_cpu_info" not in datapoint
            ):
                continue

            stop_time = datapoint["time"]
            timestamps.append(stop_time)
            if not start_time:
                start_time = stop_time

            # Get the basic CPU and memory info
            total_cpu_percent.append(datapoint.get("total_cpu_percent", 0))
            # Use rss_memory to include all the shared libraries
            if "per_process_cpu_info" not in datapoint:
                total_mem_usage.append(0)
            else:
                s = 0
                for e in datapoint["per_process_cpu_info"]:
                    v = e.get("rss_memory", 0)
                    # The value can be None
                    if not v:
                        v = 0
                    s += v
                total_mem_usage.append(s)

            gpu_key = (
                "total_gpu_utilization"
                if "total_gpu_utilization" in datapoint
                else "total_gpu_utilizaiton"
            )
            total_gpu_utilization.append(datapoint.get(gpu_key, 0))

            if "per_process_gpu_info" not in datapoint:
                total_gpu_mem_usage.append(0)
            else:
                s = 0
                for e in datapoint["per_process_gpu_info"]:
                    v = e.get("gpu_memory", 0)
                    # The value can be None
                    if not v:
                        v = 0
                    s += v
                total_gpu_mem_usage.append(s)

        uniq_id = f"{workflow_id} / {job_id}"
        # Let's also keep the starting time and ending time of the job run, so the usage can be mapped to
        # the timeline if necessary
        jobs[uniq_id] = {
            "start_time": start_time,
            "stop_time": stop_time,
        }

    idx = pd.to_datetime(timestamps)

    cpu = pd.Series(data=total_cpu_percent, index=idx)
    mem = pd.Series(data=total_mem_usage, index=idx)
    gpu = pd.Series(data=total_gpu_utilization, index=idx)
    gpu_mem = pd.Series(data=total_gpu_mem_usage, index=idx)

    # Re-sampling the raw data into x minute bucket
    resampled_cpu = cpu.resample(RESAMPLING_WINDOW).mean().round().fillna(0)
    resampled_mem = mem.resample(RESAMPLING_WINDOW).mean().round().fillna(0)
    resampled_gpu = gpu.resample(RESAMPLING_WINDOW).mean().round().fillna(0)
    resampled_gpu_mem = gpu_mem.resample(RESAMPLING_WINDOW).mean().round().fillna(0)

    return {
        "timestamp": resampled_cpu.index.strftime(DATETIME_FORMAT).to_list(),
        "cpu": resampled_cpu.to_list(),
        "mem": resampled_mem.to_list(),
        "gpu": resampled_gpu.to_list(),
        "gpu_mem": resampled_gpu_mem.to_list(),
        "jobs": jobs,
    }


async def aggregate(body: str, context: Any) -> str:
    """
    Aggregate all the usage logs specified by the provided parameters
    """
    if not body:
        return json.dumps({"error": "Invalid input"})

    try:
        params = json.loads(body)
    except JSONDecodeError as error:
        return json.dumps({"error": error})

    owner = params.get("owner", PYTORCH)
    repo = params.get("repo", PYTORCH)

    # i.e. linux-bionic-cuda11.6-py3.10-gcc7 / test (default, 1, 4, linux.4xlarge.nvidia.gpu)
    job_name = params.get("jobName")
    # Other parameters including workflowName, testFile, and testClass are not needed right
    # now at the current level of granularity. However, they're there for future usage
    if not job_name:
        return json.dumps({"error": "Missing jobName"})

    prefix = await _get_usage_log_prefix(job_name=job_name)
    if not prefix:
        return json.dumps({"error": "Failed to read from S3"})

    # Tne params should contain a list of workflow ids and job ids of the same length. Normally, they come from
    # Rockset query test_insights_latest_runs
    workflow_ids = params.get("workflowIds", [])
    jobs_ids = params.get("jobIds", [])

    if not workflow_ids or not jobs_ids or len(workflow_ids) != len(jobs_ids):
        return json.dumps({"error": "Missing workflowIds or jobIds"})

    # Note that this lambda download and process the usage logs from S3 GHA artifacts bucket, so there is only so
    # much that it can process. I'm using an arbitrary limit of MAX_ARTIFACTS for now
    if len(workflow_ids) > MAX_ARTIFACTS:
        workflow_ids = workflow_ids[:MAX_ARTIFACTS]
        jobs_ids = jobs_ids[:MAX_ARTIFACTS]

    session = get_session()
    async with session.create_client(
        "s3",
        region_name="us-east-1",
    ) as s3_client:
        raw_logs = [
            entry
            async for entry in get_usage_log(
                s3_client=s3_client,
                owner=owner,
                repo=repo,
                prefix=prefix,
                workflow_ids=workflow_ids,
                job_ids=jobs_ids,
            )
        ]

    results = await _process_raw_logs(raw_logs=raw_logs)
    return json.dumps(results)


def lambda_handler(event: Any, context: Any):
    body = event.get("body", "")
    print(f"Processing event: {body}")

    results = asyncio.run(aggregate(body, context))
    print(f"Finish processing event: {results}")
    return {"statusCode": 200, "body": results}


if os.getenv("DEBUG", "0") == "1":
    mock_body = {
        "jobName": "win-vs2019-cpu-py3 / test (default, 1, 3, windows.4xlarge.nonephemeral)",
        "workflowIds": [
            "7824285997",
        ],
        "jobIds": [
            21347334930,
        ],
    }
    # For local development
    print(
        lambda_handler(
            {
                "resource": "/usage-log-aggregator",
                "path": "/usage-log-aggregator",
                "httpMethod": "POST",
                "headers": {
                    "accept": "application/json",
                    "content-type": "application/json; charset=utf-8",
                    "Host": "0y7izelft6.execute-api.us-east-1.amazonaws.com",
                    "X-Amzn-Trace-Id": "Root=1-633d5d3c-455c3c8842a100cc4da9eb14",
                    "X-Forwarded-For": "IP",
                    "X-Forwarded-Port": "443",
                    "X-Forwarded-Proto": "https",
                },
                "body": json.dumps(mock_body),
            },
            None,
        )
    )
