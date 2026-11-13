import gzip
import json
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest import main, mock, TestCase

from torchci.td.scorer import __main__ as cli, logs, report_upload


ENV = {
    "GITHUB_REPOSITORY": "pytorch/test-infra",
    "GITHUB_REF": "refs/heads/main",
    "GITHUB_EVENT_NAME": "schedule",
    "GITHUB_RUN_ID": "19400000001",
    "GITHUB_RUN_ATTEMPT": "2",
    "GITHUB_RUN_NUMBER": "7",
    "GITHUB_WORKFLOW": "TD scorer refit",
    "GITHUB_JOB": "refit",
}
KEY = "ossci_uploaded_metrics/td_scorer_refit_19400000001_2.jsonl.gz"
REPORT_TEXT = (
    '{"passed": true, "floor_ratio": 0.6, "ratio": NaN,'
    ' "budget": {"retention": Infinity, "cost_share": -Infinity},'
    ' "walk_forward": [{"month": "2026-11", "risk_auc": NaN, "events": 3}],'
    ' "days": {"training": 45, "gate": 14, "gaps": 0, "unhealthy": 0, "missing": 0}}'
)
ROW_KEYS = {
    "repo",
    "workflow",
    "build_environment",
    "job",
    "test_config",
    "pr_number",
    "run_id",
    "run_number",
    "run_attempt",
    "job_id",
    "job_name",
    "metric_name",
    "calling_file",
    "calling_module",
    "calling_function",
    "timestamp",
    "info",
}


class ClientError(Exception):
    def __init__(self, response, operation_name):
        super().__init__(operation_name)
        self.response = response


class TestReportUpload(TestCase):
    def setUp(self) -> None:
        # torchci pins boto3 1.19.12, whose botocore fails to import on Python 3.12, so
        # the tests stand in for both modules.
        self.client = mock.Mock()
        self.client.head_object.side_effect = ClientError(
            {"Error": {"Code": "404"}}, "HeadObject"
        )
        fakes = {
            "boto3": mock.Mock(client=mock.Mock(return_value=self.client)),
            "botocore": mock.Mock(),
            "botocore.exceptions": mock.Mock(ClientError=ClientError),
        }
        patcher = mock.patch.dict(sys.modules, fakes)
        patcher.start()
        self.addCleanup(patcher.stop)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.report = Path(tmp.name) / "report.json"
        self.report.write_text(REPORT_TEXT)

    def upload(self, env=ENV, report=None) -> int:
        with mock.patch.dict("os.environ", env, clear=True):
            return cli.main(["upload-report", "--report", str(report or self.report)])

    def uploaded_row(self):
        self.client.put_object.assert_called_once()
        kwargs = self.client.put_object.call_args.kwargs
        self.assertEqual(kwargs["Bucket"], logs.RAW_BUCKET)
        self.assertEqual(kwargs["Key"], KEY)
        lines = gzip.decompress(kwargs["Body"]).decode().splitlines()
        self.assertEqual(len(lines), 1)
        return json.loads(lines[0])

    def test_metric_name(self) -> None:
        self.assertEqual(report_upload.METRIC_NAME, "td_scorer_refit")

    def test_uploads_one_row(self) -> None:
        with self.assertLogs(report_upload.logger, "INFO") as logged:
            self.assertEqual(self.upload(), 0)
        row = self.uploaded_row()
        self.assertEqual(set(row), ROW_KEYS)
        self.assertEqual(
            {k: v for k, v in row.items() if k not in ("timestamp", "info")},
            {
                "repo": "pytorch/test-infra",
                "workflow": "TD scorer refit",
                "build_environment": "",
                "job": "refit",
                "test_config": "",
                "pr_number": 0,
                "run_id": 19400000001,
                "run_number": 7,
                "run_attempt": 2,
                "job_id": 0,
                "job_name": "",
                "metric_name": "td_scorer_refit",
                "calling_file": "report_upload.py",
                "calling_module": "torchci.td.scorer.report_upload",
                "calling_function": "upload_report",
            },
        )
        stamp = datetime.strptime(row["timestamp"], "%Y-%m-%d %H:%M:%S.%f")
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        self.assertLess(abs((now - stamp).total_seconds()), 60)
        self.assertEqual(
            row["info"],
            {
                "passed": True,
                "floor_ratio": 0.6,
                "ratio": None,
                "budget": {"retention": None, "cost_share": None},
                "walk_forward": [{"month": "2026-11", "risk_auc": None, "events": 3}],
                "days": {
                    "training": 45,
                    "gate": 14,
                    "gaps": 0,
                    "unhealthy": 0,
                    "missing": 0,
                },
            },
        )
        size = len(self.client.put_object.call_args.kwargs["Body"])
        self.assertEqual(
            logged.output,
            [f"INFO:{report_upload.__name__}:uploaded {KEY} ({size} bytes)"],
        )

    def test_body_never_holds_nan(self) -> None:
        record = {"info": report_upload.finite({"a": [float("nan"), 1.5]})}
        line = gzip.decompress(report_upload.body(record)).decode()
        self.assertEqual(line, '{"info": {"a": [null, 1.5]}}\n')
        with self.assertRaises(ValueError):
            report_upload.body({"info": float("inf")})

    def test_workflow_dispatch_uploads(self) -> None:
        self.assertEqual(
            self.upload({**ENV, "GITHUB_EVENT_NAME": "workflow_dispatch"}), 0
        )
        self.uploaded_row()

    def test_existing_key_is_not_overwritten(self) -> None:
        self.client.head_object.side_effect = None
        with self.assertLogs(report_upload.logger, "INFO") as logged:
            self.assertEqual(self.upload(), 0)
        self.client.put_object.assert_not_called()
        self.assertIn(f"{KEY} already exists", logged.output[0])

    def test_refusals_write_nothing(self) -> None:
        bad_env = [
            {**ENV, "GITHUB_REPOSITORY": "someone/test-infra"},
            {**ENV, "GITHUB_REF": "refs/heads/feature"},
            {**ENV, "GITHUB_REF": "refs/pull/1/merge"},
            {**ENV, "GITHUB_EVENT_NAME": "pull_request"},
            {**ENV, "GITHUB_EVENT_NAME": "push"},
            {**ENV, "GITHUB_RUN_ID": ""},
            {**ENV, "GITHUB_RUN_ID": "0"},
            {**ENV, "GITHUB_RUN_ID": "-5"},
            {**ENV, "GITHUB_RUN_ID": "12a"},
            {**ENV, "GITHUB_RUN_ATTEMPT": "0"},
            {**ENV, "GITHUB_RUN_ATTEMPT": "1/../x"},
            {**ENV, "GITHUB_RUN_NUMBER": "٣"},
            {k: v for k, v in ENV.items() if k != "GITHUB_RUN_NUMBER"},
            {k: v for k, v in ENV.items() if k != "GITHUB_REPOSITORY"},
        ]
        for env in bad_env:
            with self.subTest(env=env), self.assertLogs(
                report_upload.logger, "ERROR"
            ) as logged:
                self.assertEqual(self.upload(env), 1)
                self.assertIn("not uploading the report", logged.output[0])
        missing = self.report.with_name("missing.json")
        not_object = self.report.with_name("list.json")
        not_object.write_text("[1, 2]")
        not_json = self.report.with_name("bad.json")
        not_json.write_text("{")
        for report in (missing, not_object, not_json, self.report.parent):
            with self.subTest(report=report), self.assertLogs(
                report_upload.logger, "ERROR"
            ):
                self.assertEqual(self.upload(report=report), 1)
        self.client.put_object.assert_not_called()
        self.client.head_object.assert_not_called()


if __name__ == "__main__":
    main()
