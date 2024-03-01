#!/usr/bin/env python3

import datetime
import logging
import os
import random
import string
import sys
import time
from enum import Enum
from logging import info
from typing import Any, Dict, List, Optional
from warnings import warn

import boto3
import requests


POLLING_DELAY_IN_SECOND = 5
MAX_UPLOAD_WAIT_IN_SECOND = 600

AWS_REGION = "us-west-2"
# NB: This is the curated top devices from AWS. We could create our own device
# pool if we want to
AWS_GUID = "082d10e5-d7d7-48a5-ba5c-b33d66efa1f5"
DEFAULT_DEVICE_POOL_ARN = f"arn:aws:devicefarm:{AWS_REGION}::devicepool:{AWS_GUID}"


# Device Farm report type
class ReportType(Enum):
    RUN = "run"
    JOB = "job"
    SUITE = "suite"
    TEST = "test"


DEVICE_FARM_BUCKET = "gha-artifacts"

logging.basicConfig(level=logging.INFO)


def parse_args() -> Any:
    from argparse import ArgumentParser

    parser = ArgumentParser("Run iOS tests on AWS Device Farm")
    parser.add_argument(
        "--project-arn", type=str, required=True, help="the ARN of the project on AWS"
    )
    parser.add_argument(
        "--app-file", type=str, required=True, help="the iOS ipa app archive"
    )
    parser.add_argument(
        "--xctest-file",
        type=str,
        required=True,
        help="the XCTest suite to run",
    )
    parser.add_argument(
        "--name-prefix",
        type=str,
        required=True,
        help="the name prefix of this test run",
    )
    parser.add_argument(
        "--device-pool-arn",
        type=str,
        default=DEFAULT_DEVICE_POOL_ARN,
        help="the name of the device pool to test on",
    )
    parser.add_argument(
        "--workflow-id",
        type=str,
        default="invalid-workflow-id",
        help="the workflow run ID",
    )
    parser.add_argument(
        "--workflow-attempt",
        type=int,
        default=0,
        help="the workflow run attempt",
    )

    return parser.parse_args()


def upload_file(
    client: Any,
    project_arn: str,
    prefix: str,
    filename: str,
    filetype: str,
    mime: str = "application/octet-stream",
) -> str:
    """
    Upload the app file and XCTest suite to AWS
    """
    r = client.create_upload(
        projectArn=project_arn,
        name=f"{prefix}_{os.path.basename(filename)}",
        type=filetype,
        contentType=mime,
    )
    upload_name = r["upload"]["name"]
    upload_arn: str = r["upload"]["arn"]
    upload_url = r["upload"]["url"]

    with open(filename, "rb") as file_stream:
        info(f"Uploading {filename} to Device Farm as {upload_name}...")
        r = requests.put(upload_url, data=file_stream, headers={"content-type": mime})
        if not r.ok:
            raise Exception(f"Couldn't upload {filename}: {r.reason}")

    status = ""
    start_time = datetime.datetime.now()
    # Polling AWS till the uploaded file is ready
    while status != "SUCCEEDED":
        waiting_time = datetime.datetime.now() - start_time
        if waiting_time > datetime.timedelta(seconds=MAX_UPLOAD_WAIT_IN_SECOND):
            raise Exception(
                f"Uploading {filename} is taking longer than {MAX_UPLOAD_WAIT_IN_SECOND} seconds, terminating..."
            )

        r = client.get_upload(arn=upload_arn)
        status = r["upload"].get("status", "")

        info(f"{filename} is in state {status} after {waiting_time}")

        if status == "FAILED":
            raise Exception(f"Couldn't upload {filename}: {r}")
        time.sleep(POLLING_DELAY_IN_SECOND)

    return upload_arn


def is_success(result: Optional[str]) -> bool:
    return result == "PASSED"


def download_artifact(artifact_url: str, local_filename: str) -> str:
    """
    Download an artifact to local
    """
    response = requests.get(artifact_url)
    with open(local_filename, "wb") as f:
        f.write(response.content)
    return local_filename


def upload_file_to_s3(
    file_name: str,
    bucket: str,
    key: str,
) -> None:
    """
    Upload a local file to S3
    """
    boto3.client("s3").upload_file(
        file_name,
        bucket,
        key,
    )


def print_test_artifacts(
    client: Any, test_arn: str, workflow_id: str, workflow_attempt: int, indent: int = 0
) -> List[Dict[str, str]]:
    """
    Return all artifacts from this specific test. There are 3 types of artifacts
    from Device Farm including FILE, LOG, and SCREENSHOT
    """
    gathered_artifacts = []

    for artifact_type in ["FILE", "LOG", "SCREENSHOT"]:
        r = client.list_artifacts(arn=test_arn, type=artifact_type)
        for artifact in r.get("artifacts", []):
            filetype = artifact["type"]
            filename = artifact["name"].replace(" ", "_")
            extension = artifact["extension"].replace(" ", "_")

            local_filename = (
                artifact["arn"].replace(":", "_").replace("/", "_")
                + f"_{filename}.{extension}"
            )
            s3_key = f"device_farm/{workflow_id}/{workflow_attempt}/{local_filename}"
            # Download the artifact locally
            upload_file_to_s3(
                download_artifact(artifact["url"], local_filename),
                DEVICE_FARM_BUCKET,
                s3_key,
            )

            info(
                f"{' ' * indent}Saving {artifact_type} {filename}.{extension} ({filetype}) "
                + f"at https://{DEVICE_FARM_BUCKET}.s3.amazonaws.com/{s3_key}"
            )
            gathered_artifacts.append(artifact)

    return gathered_artifacts


def print_report(
    client: Any,
    report: Dict[str, Any],
    rtype: ReportType,
    workflow_id: str,
    workflow_attempt: int,
    indent: int = 0,
) -> List[Dict[str, str]]:
    """
    Print the test report from Device Farm in a friendly way and return the list
    of any notable artifacts from the test run, i.e. logs and screenshots
    """
    if not report:
        warn("Missing report, returning...")
        return []

    name = report["name"]
    result = report["result"]

    extra_msg = ""
    if rtype == ReportType.SUITE or is_success(result):
        counters = report["counters"]
        extra_msg = f"with stats {counters}"

    info(f"{' ' * indent}{name} {result} {extra_msg}")

    if is_success(result):
        return []

    arn = report["arn"]
    if rtype == ReportType.RUN:
        more_reports = client.list_jobs(arn=arn)
        next_rtype = ReportType.JOB
    elif rtype == ReportType.JOB:
        more_reports = client.list_suites(arn=arn)
        next_rtype = ReportType.SUITE
    elif rtype == ReportType.SUITE:
        more_reports = client.list_tests(arn=arn)
        next_rtype = ReportType.TEST
    elif rtype == ReportType.TEST:
        return print_test_artifacts(
            client, arn, workflow_id, workflow_attempt, indent + 2
        )

    artifacts = []
    for more_report in more_reports.get(f"{next_rtype.value}s", []):
        artifacts.extend(
            print_report(
                client,
                more_report,
                next_rtype,
                workflow_id,
                workflow_attempt,
                indent + 2,
            )
        )
    return artifacts


# TODO(huydhn): Extend this to support Android
def main() -> None:
    args = parse_args()

    name_prefix = args.name_prefix
    workflow_id = args.workflow_id
    workflow_attempt = args.workflow_attempt

    # NB: Device Farm is only available in us-west-2 region atm
    client = boto3.client("devicefarm", region_name=AWS_REGION)
    unique_prefix = (
        f"{name_prefix}-{workflow_id}-{workflow_attempt}-"
        + f"{datetime.date.today().isoformat()}-{''.join(random.sample(string.ascii_letters, 8))}"
    )

    # Upload the test app
    appfile_arn = upload_file(
        client=client,
        project_arn=args.project_arn,
        prefix=unique_prefix,
        filename=args.app_file,
        filetype="IOS_APP",
    )
    info(f"Uploaded app: {appfile_arn}")
    # Upload the XCTest suite
    xctest_arn = upload_file(
        client=client,
        project_arn=args.project_arn,
        prefix=unique_prefix,
        filename=args.xctest_file,
        filetype="XCTEST_TEST_PACKAGE",
    )
    info(f"Uploaded XCTest: {xctest_arn}")

    # Schedule the test
    r = client.schedule_run(
        projectArn=args.project_arn,
        name=unique_prefix,
        appArn=appfile_arn,
        devicePoolArn=args.device_pool_arn,
        test={"type": "XCTEST", "testPackageArn": xctest_arn},
    )
    run_arn = r["run"]["arn"]

    start_time = datetime.datetime.now()
    info(f"Run {unique_prefix} is scheduled as {run_arn}")

    state = "UNKNOWN"
    result = ""
    try:
        while True:
            r = client.get_run(arn=run_arn)
            state = r["run"]["status"]

            if state == "COMPLETED":
                result = r["run"]["result"]
                break

            waiting_time = datetime.datetime.now() - start_time
            info(f"Run {unique_prefix} in state {state} after {waiting_time}")
            time.sleep(30)
    except Exception as error:
        warn(f"Failed to run {unique_prefix}: {error}")
        sys.exit(1)
    finally:
        print_report(
            client, r.get("run"), ReportType.RUN, workflow_id, workflow_attempt
        )

    if not is_success(result):
        sys.exit(1)


if __name__ == "__main__":
    main()
