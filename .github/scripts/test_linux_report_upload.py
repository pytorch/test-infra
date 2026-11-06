import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = yaml.safe_load((ROOT / ".github/workflows/linux_job_v3.yml").read_text())
STEPS = WORKFLOW["jobs"]["job"]["steps"]
SETUP = next(step for step in STEPS if step["name"] == "Prepare test run reports")
UPLOAD = next(step for step in STEPS if step["name"] == "Upload test run reports")


class LinuxReportUploadTest(unittest.TestCase):
    def test_positive_check_run_id_sets_report_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / "env"
            result = subprocess.run(
                ["bash", "-euc", SETUP["run"]],
                env={
                    **os.environ,
                    "REPORT_JOB_ID": "12345",
                    "RUNNER_TEMP": tmp,
                    "GITHUB_ENV": str(env_file),
                },
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                env_file.read_text().splitlines(),
                ["JOB_ID=12345", f"RUNNER_TEST_RUN_REPORTS_DIR={tmp}/test-run-reports"],
            )
            self.assertTrue((Path(tmp) / "test-run-reports").is_dir())

    def test_unavailable_id_warns_without_changing_environment(self):
        for job_id in ("", "0", "not-an-id"):
            with self.subTest(job_id=job_id), tempfile.TemporaryDirectory() as tmp:
                env_file = Path(tmp) / "env"
                result = subprocess.run(
                    ["bash", "-euc", SETUP["run"]],
                    env={
                        **os.environ,
                        "REPORT_JOB_ID": job_id,
                        "RUNNER_TEMP": tmp,
                        "GITHUB_ENV": str(env_file),
                    },
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("::warning::", result.stdout)
                self.assertFalse(env_file.exists())

    def test_upload_is_default_off_and_nonblocking(self):
        inputs = WORKFLOW[True]["workflow_call"]["inputs"]
        self.assertIs(inputs["upload-test-run-reports"]["default"], False)
        for step in (SETUP, UPLOAD):
            self.assertIn("inputs.upload-test-run-reports", step["if"])
            self.assertIs(step["continue-on-error"], True)
        self.assertEqual(UPLOAD["with"]["if-no-files-found"], "ignore")
        self.assertIn("always()", UPLOAD["if"])
        self.assertIn("steps.aws-creds.outcome == 'success'", UPLOAD["if"])
        self.assertIn(
            "github.event.pull_request.head.repo.full_name != github.repository",
            UPLOAD["if"],
        )

    def test_upload_action_is_resolved_without_a_workspace_checkout(self):
        self.assertEqual(
            UPLOAD["uses"],
            "pytorch/test-infra/.github/actions/upload-artifact-s3@985283436b71295931c3b0d18e271d5fb7cc750c",
        )

    def test_one_identity_and_flat_upload_path_without_api_lookup(self):
        self.assertEqual(SETUP["env"]["REPORT_JOB_ID"], "${{ job.check_run_id }}")
        self.assertEqual(
            UPLOAD["with"]["s3-prefix"],
            "torchci-reports/${{ github.repository }}/${{ github.run_id }}/${{ job.check_run_id }}",
        )
        self.assertEqual(
            UPLOAD["with"]["path"], "${{ runner.temp }}/test-run-reports/*.report.jsonl"
        )
        self.assertFalse(
            any("get-workflow-job-id" in step.get("uses", "") for step in STEPS)
        )
        script = next(step for step in STEPS if step["name"] == "Run script")
        self.assertNotIn("JOB_ID", script["env"])


if __name__ == "__main__":
    unittest.main()
