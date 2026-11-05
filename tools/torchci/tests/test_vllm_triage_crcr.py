"""Tests for turning vLLM root-cause findings into CRCR late reports."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import torchci.vllm_triage_crcr as vtc


def _relay_validator():
    """The relay's own verdict validator, to prove it accepts what is built here."""
    path = (
        Path(__file__).resolve().parents[3]
        / "aws/lambda/cross_repo_ci_relay/utils/triage_verdict.py"
    )
    spec = importlib.util.spec_from_file_location("relay_triage_verdict", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.validate_triage_verdict


JOB_URL = "https://buildkite.com/vllm/ci/builds/91827#0194a4f1-aaaa-bbbb"
OTHER_URL = "https://buildkite.com/vllm/ci/builds/91827#0194a4f1-cccc-dddd"
REPORT = {
    "regressed": [{"name": "Kernels Core [shard 2]", "url": JOB_URL}],
    "both": [{"name": "Basic Models", "url": OTHER_URL}],
}


def _cause(**overrides):
    cause = {
        "title": "aten::foo lost its out= overload",
        "summary": "torch nightly dropped the overload vLLM calls.",
        "signature": "RuntimeError: no matching overload for foo.out",
        "clusters": ["Kernels Core"],
        "job_urls": [],
        "routing": "pytorch/pytorch",
        "classification_confidence": "high",
        "determined": True,
    }
    cause.update(overrides)
    return cause


def _plan(*causes, report=REPORT):
    return vtc.plan_reports(
        {"causes": list(causes)}, report, "2026-11-05T00:00:00Z", {"model": "m"}
    )


class TestPlanReports(unittest.TestCase):
    def test_a_job_is_named_as_vllm_reported_it_and_the_relay_accepts_the_verdict(self):
        reports, _ = _plan(_cause())

        self.assertEqual(
            [{k: v for k, v in r.items() if k != "triage_verdict"} for r in reports],
            [
                {
                    "delivery_id": "buildkite-91827-0194a4f1-aaaa-bbbb",
                    "workflow_name": "ci",
                    "job_name": "Kernels Core",  # no ` [shard 2]`
                }
            ],
        )
        verdict = reports[0]["triage_verdict"]
        self.assertEqual(
            (verdict["category"], verdict["confidence"]), ("upstream", "high")
        )
        self.assertIsNotNone(_relay_validator()(verdict))

    def test_a_cluster_named_with_its_shard_is_only_that_shard(self):
        report = {
            "regressed": [
                {"name": "Kernels Core", "url": JOB_URL},
                {"name": "Kernels Core [shard 2]", "url": OTHER_URL},
            ]
        }
        reports, _ = _plan(_cause(clusters=["Kernels Core [shard 2]"]), report=report)
        self.assertEqual(
            [r["delivery_id"] for r in reports],
            ["buildkite-91827-0194a4f1-cccc-dddd"],
        )

    def test_a_url_only_the_findings_name_matches_nothing(self):
        # The findings come from untrusted logs; only the report lists real jobs.
        reports, counts = _plan(
            _cause(clusters=[], job_urls=["https://buildkite.com/vllm/ci/builds/1#x"])
        )
        self.assertEqual(reports, [])
        self.assertEqual(counts["unknown_urls"], 1)

    def test_a_cause_the_agent_did_not_determine_is_unknown(self):
        reports, _ = _plan(_cause(determined=False))
        verdict = reports[0]["triage_verdict"]
        self.assertEqual(
            (verdict["category"], verdict["confidence"]), ("unknown", "low")
        )

    def test_the_surer_cause_wins_a_job_two_causes_claim(self):
        reports, _ = _plan(
            _cause(summary="weak guess", classification_confidence="low"),
            _cause(summary="solid", routing="vllm-project/vllm"),
        )
        verdict = reports[0]["triage_verdict"]
        self.assertEqual(
            (verdict["summary"], verdict["category"]), ("solid", "backend")
        )

    def test_on_equal_confidence_the_more_specific_cause_wins(self):
        reports, _ = _plan(
            _cause(
                summary="catch-all", clusters=["Kernels Core", "Basic Models", "a", "b"]
            ),
            _cause(summary="specific", routing="vllm-project/vllm"),
        )
        verdict = reports[0]["triage_verdict"]
        self.assertEqual(
            (verdict["summary"], verdict["category"]), ("specific", "backend")
        )


class TestMain(unittest.TestCase):
    def run_main(self, findings):
        with tempfile.TemporaryDirectory() as d:
            paths = {}
            for name, data in (("findings", findings), ("report", REPORT)):
                paths[name] = Path(d, f"{name}.json")
                paths[name].write_text(json.dumps(data))
            out = Path(d, "reports.json")
            code = vtc.main(
                [
                    "--findings",
                    str(paths["findings"]),
                    "--report",
                    str(paths["report"]),
                    "--output",
                    str(out),
                ]
            )
            return code, json.loads(out.read_text()) if out.exists() else None

    def test_the_reports_are_written_for_the_action_to_send(self):
        code, written = self.run_main({"causes": [_cause()]})
        self.assertEqual(code, 0)
        self.assertEqual([r["job_name"] for r in written], ["Kernels Core"])

    def test_nothing_is_written_when_no_cause_explains_a_job(self):
        code, written = self.run_main({"causes": []})
        self.assertEqual(code, 0)
        self.assertIsNone(written)


if __name__ == "__main__":
    unittest.main()
