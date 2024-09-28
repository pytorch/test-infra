#!/usr/bin/env python3

import json
import datetime
import logging
import os
import random
import string
import sys
import time
from argparse import Action, ArgumentParser, Namespace
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
AWS_ARN_PREFIX = "arn:aws:devicefarm:"
DEFAULT_DEVICE_POOL_ARN = f"{AWS_ARN_PREFIX}{AWS_REGION}::devicepool:{AWS_GUID}"


# Device Farm report type
class ReportType(Enum):
    RUN = "run"
    JOB = "job"
    SUITE = "suite"
    TEST = "test"


DEVICE_FARM_BUCKET = "gha-artifacts"

logging.basicConfig(level=logging.INFO)


class ValidateArchive(Action):
    def __call__(
        self,
        parser: ArgumentParser,
        namespace: Namespace,
        values: Any,
        option_string: Optional[str] = None,
    ) -> None:
        if values.startswith(AWS_ARN_PREFIX) or (
            os.path.isfile(values) and values.endswith(".zip")
        ):
            setattr(namespace, self.dest, values)
            return

        parser.error(f"{values} is not a valid zip archive or an existing ARN")


class ValidateExtraDataArchive(Action):
    def __call__(
        self,
        parser: ArgumentParser,
        namespace: Namespace,
        values: Any,
        option_string: Optional[str] = None,
    ) -> None:
        # This parameter is optional and can accept an empty string, or it can be
        # an existing ARN, or a local zip archive to be uploaded to AWS
        if (
            not values
            or values.startswith(AWS_ARN_PREFIX)
            or (os.path.isfile(values) and values.endswith(".zip"))
        ):
            setattr(namespace, self.dest, values)
            return

        parser.error(
            f"{values} is not a valid extra data zip archive or an existing ARN"
        )


class ValidateApp(Action):
    def __call__(
        self,
        parser: ArgumentParser,
        namespace: Namespace,
        values: Any,
        option_string: Optional[str] = None,
    ) -> None:
        # This can be a local file or an existing app that has previously been uploaded
        # to AWS
        if values.startswith(AWS_ARN_PREFIX) or (
            os.path.isfile(values)
            and (values.endswith(".apk") or values.endswith(".ipa"))
        ):
            setattr(namespace, self.dest, values)
            return

        parser.error(
            f"{values} is not a valid Android (*.apk) or iOS app name (*.ipa) or an existing ARN"
        )


class ValidateTestSpec(Action):
    def __call__(
        self,
        parser: ArgumentParser,
        namespace: Namespace,
        values: Any,
        option_string: Optional[str] = None,
    ) -> None:
        if values.startswith(AWS_ARN_PREFIX) or (
            os.path.isfile(values)
            and (values.endswith(".yml") or values.endswith(".yaml"))
        ):
            setattr(namespace, self.dest, values)
            return

        parser.error(f"{values} is not a valid test spec (*.yml, *.yaml)")


def parse_args() -> Any:
    parser = ArgumentParser("Run Android and iOS tests on AWS Device Farm")
    parser.add_argument(
        "--project-arn", type=str, required=True, help="the ARN of the project on AWS"
    )
    parser.add_argument(
        "--app",
        type=str,
        required=True,
        action=ValidateApp,
        help="the Android apk or iOS ipa app",
    )

    # One way or the other
    test_group = parser.add_mutually_exclusive_group()
    test_group.add_argument(
        "--ios-xctestrun",
        type=str,
        required=False,
        action=ValidateArchive,
        help="the iOS XCTest suite to run",
    )
    test_group.add_argument(
        "--android-instrumentation-test",
        type=str,
        required=False,
        action=ValidateApp,
        help="the Android instrumentation test suite to run",
    )

    parser.add_argument(
        "--extra-data",
        type=str,
        required=False,
        action=ValidateExtraDataArchive,
        help="the optional extra zip archive to upload to the device, i.e. exported models",
    )
    parser.add_argument(
        "--test-spec",
        type=str,
        required=True,
        action=ValidateTestSpec,
        help="the specfile to drive the test",
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
    Upload the app file and xctestrun to AWS
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


def set_output(name: str, val: Any) -> None:
    if os.getenv("GITHUB_OUTPUT"):
        with open(str(os.getenv("GITHUB_OUTPUT")), "a") as env:
            print(f"{name}={val}", file=env)
    else:
        print(f"::set-output name={name}::{val}")


def print_testspec(
    report_name: Optional[str],
    file_name: str,
    indent: int = 0,
) -> None:
    """
    The test spec output from AWS Device Farm is the main output of the test job.
    """
    print(f"::group::{report_name} test output")
    with open(file_name) as f:
        print(f.read())
    print("::endgroup::")


def print_test_artifacts(
    client: Any,
    test_arn: str,
    workflow_id: str,
    workflow_attempt: int,
    report_name: Optional[str],
    indent: int = 0,
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

            s3_url = f"https://{DEVICE_FARM_BUCKET}.s3.amazonaws.com/{s3_key}"
            artifact["s3_url"] = s3_url

            info(
                f"{' ' * indent}Saving {artifact_type} {filename}.{extension} ({filetype}) "
                + f"at {s3_url}"
            )

            # Some more metadata to identify where the artifact comes from
            artifact["report_name"] = report_name
            gathered_artifacts.append(artifact)

            # Additional step to print the test output
            if filetype == "TESTSPEC_OUTPUT":
                print_testspec(report_name, local_filename, indent + 2)

    return gathered_artifacts


def print_report(
    client: Any,
    report: Dict[str, Any],
    report_name: Optional[str],
    report_type: ReportType,
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
    # Keep the top-level report name as the name of the whole test report, this
    # is used to connect all artifacts from one report together
    if not report_name:
        report_name = name
    result = report["result"]

    extra_msg = ""
    if report_type == ReportType.SUITE or is_success(result):
        counters = report["counters"]
        extra_msg = f"with stats {counters}"

    info(f"{' ' * indent}{name} {result} {extra_msg}")

    arn = report["arn"]
    if report_type == ReportType.RUN:
        more_reports = client.list_jobs(arn=arn)
        next_report_type = ReportType.JOB
    elif report_type == ReportType.JOB:
        more_reports = client.list_suites(arn=arn)
        next_report_type = ReportType.SUITE
    elif report_type == ReportType.SUITE:
        more_reports = client.list_tests(arn=arn)
        next_report_type = ReportType.TEST
    elif report_type == ReportType.TEST:
        return print_test_artifacts(
            client, arn, workflow_id, workflow_attempt, report_name, indent + 2
        )

    artifacts = []
    for more_report in more_reports.get(f"{next_report_type.value}s", []):
        artifacts.extend(
            print_report(
                client,
                more_report,
                report_name,
                next_report_type,
                workflow_id,
                workflow_attempt,
                indent + 2,
            )
        )
    return artifacts


def generate_ios_xctestrun(
    client: Any, project_arn: str, prefix: str, ios_xctestrun: str, test_spec: str
) -> Dict[str, str]:
    """
    A helper function to generate the iOS test run
    """
    if ios_xctestrun.startswith(AWS_ARN_PREFIX):
        xctest_arn = ios_xctestrun
        info(f"Use the existing xctestrun: {xctest_arn}")
    else:
        # Upload the xctestrun file as an appium node test package, this allows us
        # to customize the run later using a test spec
        xctest_arn = upload_file(
            client=client,
            project_arn=project_arn,
            prefix=prefix,
            filename=ios_xctestrun,
            filetype="APPIUM_NODE_TEST_PACKAGE",
        )
        info(f"Uploaded xctestrun: {xctest_arn}")

    if test_spec.startswith(AWS_ARN_PREFIX):
        test_spec_arn = test_spec
        info(f"Use the existing iOS test spec: {test_spec_arn}")
    else:
        test_spec_arn = upload_file(
            client=client,
            project_arn=project_arn,
            prefix=prefix,
            filename=test_spec,
            filetype="APPIUM_NODE_TEST_SPEC",
        )
        info(f"Uploaded iOS test spec: {test_spec_arn}")

    return {
        "type": "APPIUM_NODE",
        "testPackageArn": xctest_arn,
        "testSpecArn": test_spec_arn,
    }


def generate_android_instrumentation_test(
    client: Any,
    project_arn: str,
    prefix: str,
    android_instrumentation_test: str,
    test_spec: str,
) -> Dict[str, str]:
    """
    A helper function to generate the Android test run
    """
    if android_instrumentation_test.startswith(AWS_ARN_PREFIX):
        instrumentation_test_arn = android_instrumentation_test
        info(f"Use the existing instrumentation test: {instrumentation_test_arn}")
    else:
        # Upload the instrumentation test suite archive
        instrumentation_test_arn = upload_file(
            client=client,
            project_arn=project_arn,
            prefix=prefix,
            filename=android_instrumentation_test,
            filetype="INSTRUMENTATION_TEST_PACKAGE",
        )
        info(f"Uploaded instrumentation test: {instrumentation_test_arn}")

    if test_spec.startswith(AWS_ARN_PREFIX):
        test_spec_arn = test_spec
        info(f"Use the existing Android instrumentation test spec: {test_spec_arn}")
    else:
        test_spec_arn = upload_file(
            client=client,
            project_arn=project_arn,
            prefix=prefix,
            filename=test_spec,
            filetype="INSTRUMENTATION_TEST_SPEC",
        )
        info(f"Uploaded Android test spec: {test_spec_arn}")

    return {
        "type": "INSTRUMENTATION",
        "testPackageArn": instrumentation_test_arn,
        "testSpecArn": test_spec_arn,
    }


def generate_test_configuration(
    client: Any, project_arn: str, prefix: str, extra_data: str
) -> Dict[str, str]:
    """
    A helper function to generate the test configuration
    """
    if extra_data.startswith(AWS_ARN_PREFIX):
        extra_data_arn = extra_data
        info(f"Use the existing extra data: {extra_data_arn}")
    else:
        # Upload the extra data used by the test
        extra_data_arn = upload_file(
            client=client,
            project_arn=project_arn,
            prefix=prefix,
            filename=extra_data,
            filetype="EXTERNAL_DATA",
        )
        info(f"Uploaded extra data used by the test: {extra_data_arn}")

    # See https://docs.aws.amazon.com/cli/latest/reference/devicefarm/schedule-run.html
    return {"extraDataPackageArn": extra_data_arn}


def main() -> None:
    args = parse_args()

    project_arn = args.project_arn
    name_prefix = args.name_prefix
    workflow_id = args.workflow_id
    workflow_attempt = args.workflow_attempt

    # NB: Device Farm is only available in us-west-2 region atm
    client = boto3.client("devicefarm", region_name=AWS_REGION)
    unique_prefix = (
        f"{name_prefix}-{workflow_id}-{workflow_attempt}-"
        + f"{datetime.date.today().isoformat()}-{''.join(random.sample(string.ascii_letters, 8))}"
    )

    if args.app.startswith(AWS_ARN_PREFIX):
        appfile_arn = args.app
        info(f"Use the existing app: {appfile_arn}")
    else:
        # Only Android and iOS app are supported atm
        app_type = "ANDROID_APP" if args.app.endswith(".apk") else "IOS_APP"
        # Upload the test app
        appfile_arn = upload_file(
            client=client,
            project_arn=project_arn,
            prefix=unique_prefix,
            filename=args.app,
            filetype=app_type,
        )
        info(f"Uploaded app: {appfile_arn}")

    if args.ios_xctestrun:
        test_to_run = generate_ios_xctestrun(
            client, project_arn, unique_prefix, args.ios_xctestrun, args.test_spec
        )

    if args.android_instrumentation_test:
        test_to_run = generate_android_instrumentation_test(
            client,
            project_arn,
            unique_prefix,
            args.android_instrumentation_test,
            args.test_spec,
        )

    configuration = {}
    if args.extra_data:
        configuration = generate_test_configuration(
            client, project_arn, unique_prefix, args.extra_data
        )

    # Schedule the test
    r = client.schedule_run(
        projectArn=project_arn,
        name=unique_prefix,
        appArn=appfile_arn,
        devicePoolArn=args.device_pool_arn,
        test=test_to_run,
        configuration=configuration,
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
        artifacts = print_report(
            client, r.get("run"), None, ReportType.RUN, workflow_id, workflow_attempt
        )
        set_output("artifacts", json.dumps(artifacts))

    if not is_success(result):
        sys.exit(1)


if __name__ == "__main__":
    main()
