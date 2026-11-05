import json
import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = yaml.safe_load((ROOT / ".github/workflows/linux_job_v3.yml").read_text())
STEPS = WORKFLOW["jobs"]["job"]["steps"]
CHECK = next(step for step in STEPS if step.get("id") == "report-check")["run"]
SETUP = next(step for step in STEPS if step["name"] == "Prepare test run reports")[
    "run"
]


class LinuxReportUploadTest(unittest.TestCase):
    def check(self, records=None, outcome="success", allowed="true"):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            if records is not None:
                (directory / "test.report.jsonl").write_text(
                    "".join(json.dumps(row) + "\n" for row in records)
                )
            output = directory / "output"
            env = {
                **os.environ,
                "RUNNER_TEST_RUN_REPORTS_DIR": tmp,
                "GITHUB_OUTPUT": str(output),
                "GITHUB_REPOSITORY": "pytorch/executorch",
                "REPORT_JOB_ID": "12345",
                "SCRIPT_OUTCOME": outcome,
                "UPLOAD_ALLOWED": allowed,
            }
            result = subprocess.run(
                ["bash", "-euc", CHECK], env=env, text=True, capture_output=True
            )
            return result, output.read_text() if output.exists() else ""

    def records(self):
        return [
            {
                "type": "report",
                "schema_version": "1.0",
                "repo": "pytorch/executorch",
                "github_workflow_job_id": 12345,
            },
            {
                "type": "run",
                "schema_version": "1.0",
                "id": str(uuid.uuid4()),
                "file": "test_sample.py",
                "case_name": "test_pass",
            },
        ]

    def test_valid_rows_and_failed_test_results_upload(self):
        for outcome in ("success", "failure"):
            with self.subTest(outcome=outcome):
                result, output = self.check(self.records(), outcome)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("ready=true", output)

    def test_empty_success_fails_but_failed_build_skips(self):
        for records in (None, self.records()[:1]):
            self.assertNotEqual(self.check(records)[0].returncode, 0)
        result, output = self.check(outcome="failure")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ready=false", output)

    def test_wrong_schema_identity_or_uuid_fails(self):
        for target, key, value in (
            (0, "schema_version", "0.1"),
            (0, "repo", "pytorch/pytorch"),
            (0, "github_workflow_job_id", 0),
            (1, "id", "invalid"),
            (1, "file", ""),
        ):
            with self.subTest(key=key):
                records = self.records()
                records[target][key] = value
                self.assertNotEqual(self.check(records)[0].returncode, 0)

    def test_fork_or_missing_credentials_is_explicit(self):
        result, output = self.check(self.records(), allowed="false")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ready=false", output)
        self.assertIn("::warning::", result.stdout)

    def test_default_off_and_existing_job_id_action_unchanged(self):
        inputs = WORKFLOW[True]["workflow_call"]["inputs"]
        self.assertIs(inputs["upload-test-run-reports"]["default"], False)
        for step in STEPS:
            if step["name"] in (
                "Get workflow job id for reports",
                "Prepare test run reports",
                "Check test run reports",
            ):
                self.assertIn("inputs.upload-test-run-reports", step["if"])
        lookup = next(step for step in STEPS if step.get("id") == "report-job-id")
        self.assertEqual(
            lookup["uses"], "./test-infra/.github/actions/get-workflow-job-id"
        )
        script = next(step for step in STEPS if step["name"] == "Run script")
        self.assertNotIn("JOB_ID", script["env"])

    def test_prepare_rejects_empty_id_without_overwriting_environment(self):
        for job_id in ("", "0", "not-an-id", "12345"):
            with tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp) / "env"
                result = subprocess.run(
                    ["bash", "-euc", SETUP],
                    env={
                        **os.environ,
                        "REPORT_JOB_ID": job_id,
                        "RUNNER_TEMP": tmp,
                        "GITHUB_ENV": str(output),
                    },
                    capture_output=True,
                )
                self.assertEqual(result.returncode == 0, job_id == "12345")
                self.assertEqual(output.exists(), job_id == "12345")


if __name__ == "__main__":
    unittest.main()
