"""Tests for the late-report callback: triage verdicts added to rows reported earlier."""

import unittest
from unittest.mock import MagicMock, patch

from callback.callback_handler import handle
from utils.allowlist import AllowlistLevel
from utils.hud import forward_to_hud
from utils.misc import HTTPException


VERDICT = {
    "schema_version": 1,
    "category": "upstream",
    "confidence": "high",
    "summary": "aten::foo lost its out= overload.",
}


def _entry(**overrides):
    entry = {
        "delivery_id": "buildkite-91827-0194-aaaa",
        "workflow_name": "ci",
        "job_name": "Kernels",
        "triage_verdict": dict(VERDICT),
    }
    entry.update(overrides)
    return entry


def _late(reports):
    return {"event_type": "late-report", "reports": reports}


class TestLateReport(unittest.TestCase):
    def setUp(self):
        self.addCleanup(patch.stopall)
        self.allowlist = MagicMock()
        self.allowlist.get_repo_level.return_value = AllowlistLevel.L2
        patch(
            "callback.callback_handler.load_allowlist", return_value=self.allowlist
        ).start()
        patch("callback.callback_handler.check_rate_limit", return_value=True).start()
        self.hud = patch("callback.callback_handler.forward_to_hud").start()

    def handle(self, body):
        config = MagicMock(rate_limit_per_min=60)
        return handle(config, body, verified_repo="vllm-project/vllm")

    def test_reports_are_forwarded_for_the_verified_repo_and_hud_s_results_returned(
        self,
    ):
        results = [
            {"delivery_id": "d-a", "job_name": "A", "result": "attached"},
            {"delivery_id": "d-b", "job_name": "B", "result": "no_such_row"},
        ]
        self.hud.return_value = {"ok": True, "results": results}
        reports = [_entry(delivery_id="d-a", job_name="A"), _entry(job_name="B")]

        response = self.handle(_late(reports))

        self.assertEqual(
            response, {"ok": True, "status": "late-report", "results": results}
        )
        trusted, untrusted = self.hud.call_args.args[1:]
        self.assertEqual(trusted["verified_repo"], "vllm-project/vllm")
        self.assertEqual(
            untrusted["callback_payload"],
            {"event_type": "late-report", "reports": reports},
        )

    def test_a_bad_report_rejects_the_whole_request_and_names_it(self):
        for bad in (
            {k: v for k, v in _entry().items() if k != "job_name"},
            _entry(triage_verdict={"category": "nope"}),
        ):
            with self.subTest(bad=bad), self.assertRaises(HTTPException) as ctx:
                self.handle(_late([_entry(), bad]))
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertIn("reports[1]", ctx.exception.detail)
        self.hud.assert_not_called()

    def test_a_repo_that_is_not_allowlisted_is_ignored(self):
        self.allowlist.get_repo_level.return_value = None
        self.assertEqual(
            self.handle(_late([_entry()])), {"ok": True, "status": "ignored"}
        )
        self.hud.assert_not_called()


class TestForwardToHudReturnsTheAnswer(unittest.TestCase):
    @patch("utils.hud.urllib.request.urlopen")
    def test_returns_huds_json_object(self, urlopen):
        response = urlopen.return_value.__enter__.return_value
        response.status = 200
        response.read.return_value = b'{"ok": true, "results": []}'
        cfg = MagicMock(
            hud_api_url="http://hud/api/crcr/results",
            hud_bot_key="bot-key",
            hud_max_retries=0,
        )
        self.assertEqual(forward_to_hud(cfg, {}, {}), {"ok": True, "results": []})


if __name__ == "__main__":
    unittest.main()
