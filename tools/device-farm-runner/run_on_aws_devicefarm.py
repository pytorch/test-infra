#!/usr/bin/env python3

import copy
import datetime
import json
import logging
import os
import random
import string
import sys
import time
from argparse import Action, ArgumentParser, Namespace
from dataclasses import asdict, dataclass
from enum import Enum
from logging import info
from math import inf
from typing import Any, Dict, List, Optional
from warnings import warn

import boto3  # type: ignore[import-not-found]
import requests


# TODO(elainewy): refactor and add unit tests for benchmark test logic
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
    UNKNOWN = "unknown"


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

    parser.add_argument(
        "--git-job-name", type=str, required=True, help="the name of the git job name."
    )

    parser.add_argument(
        "--output",
        type=str,
        help="an optional file to write the list of artifacts from AWS in JSON format",
    )

    parser.add_argument(
        "--debug",
        action="store_true",
        help="debug mode, the artifacts won't be uploaded to s3, it should mainly used in local env",
    )

    parser.add_argument(
        "--new-json-output-format",
        type=str,
        choices=["true", "false"],
        default="false",
        required=False,
        help="enable new json artifact output format with mobile job reports and list of artifacts",
    )

    # in case when removing the flag, the mobile jobs does not failed due to unrecognized flag.
    args, unknown = parser.parse_known_args()
    if len(unknown) > 0:
        info(f"detected unknown flags: {unknown}")
    return args


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


def set_output(val: Any, gh_var_name: str, filename: Optional[str]) -> None:
    if os.getenv("GITHUB_OUTPUT"):
        with open(str(os.getenv("GITHUB_OUTPUT")), "a") as env:
            print(f"{gh_var_name}={val}", file=env)
    else:
        print(f"::set-output name={gh_var_name}::{val}")

    # Also write the value to file if it exists
    if filename:
        with open(filename, "w") as f:
            print(val, file=f)


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


@dataclass
class DeviceFarmReport:
    name: str
    arn: str
    report_type: str
    status: str
    result: str
    counters: Dict[str, str]
    app_type: str
    infos: Dict[str, str]
    parent_arn: str


@dataclass
class JobReport(DeviceFarmReport):
    os: str
    instance_arn: Optional[str]
    is_private_instance: bool


class ReportProcessor:
    """
    A helper class to process the modebile test result from AWS Device Farm.

    Usage:
        processor = ReportProcessor(...) \n
        processor.start(mobile_run_report)
    """

    def __init__(
        self,
        device_farm_client: Any,
        s3_client,
        app_type: str,
        workflow_id: str,
        workflow_attempt: int,
        is_debug: bool = False,
    ):
        self.aws_client = device_farm_client
        self.s3_client = s3_client
        self.app_type = app_type
        self.workflow_id = workflow_id
        self.workflow_attempt = workflow_attempt
        self.run_report: Optional[DeviceFarmReport] = None
        self.job_reports: list[JobReport] = []
        self.test_spec_info_list: list[Dict] = []
        self.is_debug = is_debug

    # todo(elainewy): add main method to pass run arn
    def start(self, report: Dict[str, Any]) -> List[Dict[str, str]]:
        if not report:
            warn("Missing report, returning...")
            return []

        run_arn = report.get("arn", "")
        if not run_arn:
            warn("Missing arn from input report, returning...")
            return []

        if self.is_debug:
            info(
                "[DEBUG MODE] the artifacts won't be uploaded to s3, it should mainly used in local env"
            )

        self.run_report = self._to_run_report(report)

        # fetch mobile job report from the run
        job_reports_resp = self.aws_client.list_jobs(arn=run_arn)
        res = []

        # fetch artifacts, and sub-reports for each mobile job
        for job_report in job_reports_resp.get(ReportType.JOB.value + "s", []):
            # info(f"Job Report: {jreport}")
            metadata = self._to_job_report(job_report, run_arn)
            self.job_reports.append(metadata)
            artifacts = self._fetch_artifacts_and_reports(
                job_report,
                ReportType(metadata.report_type),
                metadata,
            )
            res.extend(artifacts)
        return res

    def _fetch_artifacts_and_reports(
        self,
        report: Dict[str, Any],
        report_type: ReportType,
        job_metadata: JobReport,
        indent: int = 0,
    ) -> List[Dict[str, str]]:
        """
        DFS method that tranverse DeviceFarm report from the mobile job level,
        identifies and uploads significant artifacts (such as logs and screenshots) to AWS S3,
        and returns a comprehensive list of artifact metadata, including relevant mobile job report information.
        """
        if not report:
            warn("Missing report, returning...")
            return []

        name = report["name"]
        result = report["result"]

        extra_msg = ""
        if report_type == ReportType.SUITE or is_success(result):
            counters = report["counters"]
            extra_msg = f"with stats {counters}"

        info(f"{' ' * indent}{name} {result} {extra_msg}")

        arn = report["arn"]
        more_reports = {}
        if report_type == ReportType.JOB:
            more_reports = self.aws_client.list_suites(arn=arn)
            next_report_type = ReportType.SUITE
        elif report_type == ReportType.SUITE:
            more_reports = self.aws_client.list_tests(arn=arn)
            next_report_type = ReportType.TEST
        elif report_type == ReportType.TEST:
            return self._fetch_test_artifacts(arn, job_metadata, indent + 2)
        else:
            warn(f"Unknown report type {report_type}")
            return []

        artifacts = []
        for more_report in more_reports.get(f"{next_report_type.value}s", []):
            artifacts.extend(
                self._fetch_artifacts_and_reports(
                    more_report,
                    next_report_type,
                    job_metadata,
                    indent + 2,
                )
            )
        return artifacts

    def _to_job_report(
        self, report: Dict[str, Any], parent_arn: str, infos: Dict[str, str] = dict()
    ) -> JobReport:
        arn = report.get("arn", "")
        status = report.get("status", "")
        name = report.get("name", "")
        result = report.get("result", "")
        counters = report.get("counters", "{}")
        os = report.get("device", {}).get("os", "")

        fleet_type = report.get("device", {}).get("fleetType", "")
        is_private_instance = True if fleet_type == "PRIVATE" else False

        # NB: When running on a private device, AWS set the field instanceArn pointing
        # to that device
        instance_arn = report.get(
            "instanceArn", report.get("device", {}).get("arn", "")
        )

        return JobReport(
            arn=arn,
            name=name,
            app_type=self.app_type,
            report_type=ReportType.JOB.value,
            status=status,
            result=result,
            parent_arn=parent_arn,
            counters=counters,
            infos=infos,
            os=os,
            instance_arn=instance_arn,
            is_private_instance=is_private_instance,
        )

    def _to_run_report(self, report: Dict[str, Any], infos: Dict[str, str] = dict()):
        arn = report.get("arn", "")
        status = report.get("status", "")
        name = report.get("name", "")
        result = report.get("result", "")
        counters = report.get("counters", "{}")

        return DeviceFarmReport(
            name=name,
            arn=arn,
            app_type=self.app_type,
            report_type=ReportType.RUN.value,
            status=status,
            result=result,
            counters=counters,
            infos=infos,
            parent_arn="",
        )

    def _fetch_test_artifacts(
        self, test_arn: str, job_metadata: JobReport, indent: int = 0
    ) -> List[Dict[str, str]]:
        """
        Return all artifacts from this specific test. There are 3 types of artifacts
        from Device Farm including FILE, LOG, and SCREENSHOT
        """
        gathered_artifacts = []
        info(f"{' ' * indent} start gathering artifacts")
        for artifact_type in ["FILE", "LOG", "SCREENSHOT"]:
            r = self.aws_client.list_artifacts(arn=test_arn, type=artifact_type)
            for artifact in r.get("artifacts", []):
                filetype = artifact["type"]
                filename = artifact["name"].replace(" ", "_")
                extension = artifact["extension"].replace(" ", "_")

                local_filename = (
                    artifact["arn"].replace(":", "_").replace("/", "_")
                    + f"_{filename}.{extension}"
                )
                s3_key = f"device_farm/{self.workflow_id}/{self.workflow_attempt}/{local_filename}"

                # Download the artifact locally
                artifact_file = download_artifact(artifact["url"], local_filename)

                if not self.is_debug:
                    # upload artifacts to s3 bucket
                    self._upload_file_to_s3(artifact_file, DEVICE_FARM_BUCKET, s3_key)
                s3_url = f"https://{DEVICE_FARM_BUCKET}.s3.amazonaws.com/{s3_key}"
                artifact["s3_url"] = s3_url

                info(
                    f"{' ' * indent} Saving {artifact_type} {filename}.{extension} ({filetype}) "
                    + f"at {s3_url}"
                )

                # Some more metadata to identify where the artifact comes from
                artifact["app_type"] = self.app_type
                artifact["job_name"] = job_metadata.name
                artifact["os"] = job_metadata.os
                artifact["job_arn"] = job_metadata.arn
                artifact["job_conclusion"] = job_metadata.result
                gathered_artifacts.append(artifact)
                # Additional step to print the test output
                if filetype == "TESTSPEC_OUTPUT":
                    self.test_spec_info_list.append(
                        {
                            "job_name": job_metadata.name,
                            "os": job_metadata.os,
                            "job_arn": job_metadata.arn,
                            "job_conclusion": job_metadata.result,
                            "local_filename": local_filename,
                        }
                    )
        return gathered_artifacts

    def print_test_spec(self) -> None:
        info(f"Test Spec Outputs:")
        for test_spec_info in self.test_spec_info_list:
            self.print_single_testspec(
                test_spec_info["job_name"],
                test_spec_info["os"],
                test_spec_info["job_conclusion"],
                test_spec_info["local_filename"],
            )

    def print_single_testspec(
        self,
        job_name: str,
        os: str,
        job_conclusion: str,
        file_name: str,
    ) -> None:
        """
        The test spec output from AWS Device Farm is the main output of the test job.
        """
        print(f"::group::{job_name} {os} test output [Job Result: {job_conclusion}]")
        with open(file_name) as f:
            print(f.read())
        print("::endgroup::")

    def get_run_report(self):
        if not self.run_report:
            warn(
                "cannot print run report, run_report is empty, make sure you call start() first"
            )
            return DeviceFarmReport(
                name="",
                arn="",
                app_type=self.app_type,
                report_type=ReportType.RUN.value,
                status="",
                result="",
                counters={},
                infos={},
                parent_arn="",
            )
        return copy.deepcopy(self.run_report)

    def get_job_reports(self):
        return copy.deepcopy(self.job_reports)

    def print_run_report(self) -> None:
        if not self.run_report:
            warn(
                "cannot print run report, run_report is empty, make sure you call start() first"
            )
            return
        d = asdict(self.run_report)
        info(f"Run Report Output: {d}")

    def print_job_reports(self) -> None:
        info("Job Report Output:")
        for r in self.job_reports:
            d = json.dumps(asdict(r))
            info(f"{d}")

    def _upload_file_to_s3(self, file_name: str, bucket: str, key: str) -> None:
        """
        Upload a local file to S3
        """
        self.s3_client.upload_file(
            file_name,
            bucket,
            key,
        )


def generate_artifacts_output(
    artifacts: List[Dict[str, str]],
    run_report: DeviceFarmReport,
    job_reports: List[JobReport],
    git_job_name: str,
):
    output = {
        "artifacts": artifacts,
        "run_report": asdict(run_report),
        "job_reports": [asdict(job_report) for job_report in job_reports],
        "git_job_name": git_job_name,
    }
    return output


def main() -> None:
    args = parse_args()

    # (TODO): remove this once remove the flag.
    if args.new_json_output_format == "true":
        info(f"use new json output format for {args.output}")
    else:
        info("use legacy json output format for {args.output}")

    project_arn = args.project_arn
    name_prefix = args.name_prefix
    workflow_id = args.workflow_id
    workflow_attempt = args.workflow_attempt

    # NB: Device Farm is only available in us-west-2 region atm
    device_farm_client = boto3.client("devicefarm", region_name=AWS_REGION)

    unique_prefix = (
        f"{name_prefix}-{workflow_id}-{workflow_attempt}-"
        + f"{datetime.date.today().isoformat()}-{''.join(random.sample(string.ascii_letters, 8))}"
    )

    app_type = ""
    if args.app.startswith(AWS_ARN_PREFIX):
        appfile_arn = args.app
        info(f"Use the existing app: {appfile_arn}")
    else:
        # Only Android and iOS app are supported atm
        app_type = "ANDROID_APP" if args.app.endswith(".apk") else "IOS_APP"
        # Upload the test app
        appfile_arn = upload_file(
            client=device_farm_client,
            project_arn=project_arn,
            prefix=unique_prefix,
            filename=args.app,
            filetype=app_type,
        )
        info(f"Uploaded app: {appfile_arn}")

    test_to_run = {}

    if args.ios_xctestrun:
        app_type = "IOS_APP"
        test_to_run = generate_ios_xctestrun(
            device_farm_client,
            project_arn,
            unique_prefix,
            args.ios_xctestrun,
            args.test_spec,
        )

    if args.android_instrumentation_test:
        app_type = "ANDROID_APP"
        test_to_run = generate_android_instrumentation_test(
            device_farm_client,
            project_arn,
            unique_prefix,
            args.android_instrumentation_test,
            args.test_spec,
        )

    configuration = {}
    if args.extra_data:
        configuration = generate_test_configuration(
            device_farm_client, project_arn, unique_prefix, args.extra_data
        )

    # Schedule the test
    r = device_farm_client.schedule_run(
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
            r = device_farm_client.get_run(arn=run_arn)
            state = r["run"]["status"]
            if state == "COMPLETED":
                result = r["run"]["result"]
                break
            waiting_time = datetime.datetime.now() - start_time
            info(f"Run {unique_prefix} in state {state} after {waiting_time}")
            time.sleep(30)
    except Exception as error:
        warn(f"Failed to run {unique_prefix}: {error}")
        # just use the new json output format
        json_file = {
            "git_job_name": args.git_job_name,
        }
        set_output(json.dumps(json_file), "artifacts", args.output)
        sys.exit(1)
    finally:
        info(f"Run {unique_prefix} finished with state {state} and result {result}")
        s3_client = boto3.client("s3")
        processor = ReportProcessor(
            device_farm_client, s3_client, app_type, workflow_id, workflow_attempt
        )
        artifacts = processor.start(r.get("run"))

        if args.new_json_output_format == "true":
            output = generate_artifacts_output(
                artifacts,
                processor.get_run_report(),
                processor.get_job_reports(),
                git_job_name=args.git_job_name,
            )
            set_output(json.dumps(output), "artifacts", args.output)
        else:
            info("Generating legacy json output")
            set_output(json.dumps(artifacts), "artifacts", args.output)
        processor.print_test_spec()
    if not is_success(result):
        sys.exit(1)


if __name__ == "__main__":
    main()
