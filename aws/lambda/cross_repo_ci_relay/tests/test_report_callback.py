"""Tests for the callback reporter in .github/actions/cross-repo-ci-relay-callback.

The reporter is a standalone script rather than part of the relay package, so
it is loaded by path.
"""

import importlib.util
import io
import json
import os
import tempfile
import threading
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch


_SCRIPT = (
    Path(__file__).resolve().parents[4]
    / ".github/actions/cross-repo-ci-relay-callback/report_callback.py"
)
_spec = importlib.util.spec_from_file_location("report_callback", _SCRIPT)
rc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rc)


def _resp(http_code, body="", retry_after=None):
    returncode = 0 if http_code.startswith("2") else 22
    return rc.Response(returncode, http_code, body, retry_after)


class TestParseRetryAfter(unittest.TestCase):
    def test_reads_header_case_insensitively(self):
        headers = "HTTP/1.1 429 Too Many Requests\r\nretry-after: 3\r\n\r\n"
        self.assertEqual(rc.parse_retry_after(headers), 3)

    def test_missing_or_unparseable(self):
        self.assertIsNone(rc.parse_retry_after("HTTP/1.1 429\r\n\r\n"))
        self.assertIsNone(rc.parse_retry_after("Retry-After: soon\r\n"))


class TestSendCallback(unittest.TestCase):
    def setUp(self):
        self.sleeps = []
        patcher = patch.object(rc.time, "sleep", side_effect=self.sleeps.append)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _send(self, responses, retries=None):
        env = {} if retries is None else {"RATE_LIMIT_RETRIES": str(retries)}
        out, err = io.StringIO(), io.StringIO()
        with ExitStack() as stack:
            post = stack.enter_context(
                patch.object(rc, "post_once", side_effect=responses)
            )
            stack.enter_context(patch.dict(os.environ, env))
            stack.enter_context(redirect_stdout(out))
            stack.enter_context(redirect_stderr(err))
            try:
                rc.send_callback("{}")
                code = 0
            except SystemExit as exc:
                code = exc.code
        return code, post.call_count, out.getvalue(), err.getvalue()

    def test_relay_rate_limit_is_retried(self):
        code, calls, out, _ = self._send(
            [_resp("429", retry_after=1), _resp("429", retry_after=1), _resp("200")]
        )
        self.assertEqual((code, calls), (0, 3))
        # The backoff schedule wins over a shorter Retry-After.
        self.assertEqual(self.sleeps, [2, 4])
        self.assertIn("Relay server response HTTP: 200", out)

    def test_longer_retry_after_is_respected(self):
        self._send([_resp("429", retry_after=10), _resp("200")])
        self.assertEqual(self.sleeps, [10])

    def test_hud_429_without_retry_after_is_not_retried(self):
        code, calls, _, err = self._send(
            [_resp("429", body='{"detail": "HUD rejected callback: HTTP 429"}')]
        )
        self.assertEqual((code, calls), (22, 1))
        self.assertEqual(self.sleeps, [])
        self.assertIn("HUD rejected callback", err)

    def test_gives_up_after_the_retry_budget(self):
        code, calls, _, err = self._send(
            [_resp("429", body="rate limit exceeded", retry_after=1)] * 3, retries=2
        )
        self.assertEqual((code, calls), (22, 3))
        self.assertIn("rate limit exceeded", err)

    def test_other_errors_fail_immediately(self):
        code, calls, _, _ = self._send([_resp("500", body="boom")])
        self.assertEqual((code, calls), (22, 1))
        self.assertEqual(self.sleeps, [])


class TestPostOnce(unittest.TestCase):
    """Runs the real curl invocation against a local server."""

    def setUp(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                body = json.dumps({"detail": "rate limit exceeded for org/repo"})
                self.send_response(429)
                self.send_header("Retry-After", "7")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body.encode())

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def test_returns_status_body_and_retry_after(self):
        port = self.server.server_address[1]
        env = {
            "CALLBACK_URL": f"http://127.0.0.1:{port}/github/callback",
            "OIDC_TOKEN": "tok",
            "NO_PROXY": "127.0.0.1",
            "no_proxy": "127.0.0.1",
        }
        with tempfile.NamedTemporaryFile("w", suffix=".json") as payload:
            payload.write("{}")
            payload.flush()
            with patch.dict(os.environ, env):
                resp = rc.post_once(payload.name)
        self.assertEqual(resp.http_code, "429")
        self.assertNotEqual(resp.returncode, 0)
        self.assertEqual(resp.retry_after, 7)
        self.assertIn("rate limit exceeded for org/repo", resp.body)


VERDICT = {
    "schema_version": 1,
    "category": "upstream",
    "confidence": "high",
    "summary": "aten::foo lost its out= overload.",
}


def _report(job):
    return {
        "delivery_id": "buildkite-1-a",
        "workflow_name": "ci",
        "job_name": job,
        "triage_verdict": VERDICT,
    }


def _results(*outcomes):
    results = [
        {"delivery_id": "buildkite-1-a", "job_name": f"job-{i}", "result": outcome}
        for i, outcome in enumerate(outcomes)
    ]
    return _resp("200", json.dumps({"ok": True, "results": results}))


class TestLateReport(unittest.TestCase):
    def run_main(self, reports, responses, **env):
        env = {
            "EVENT_TYPE_OVERRIDE": "late-report",
            "TRIAGE_VERDICT_LIST": reports
            if isinstance(reports, str)
            else json.dumps(reports),
            "OIDC_TOKEN": "tok",
            "CALLBACK_URL": "http://relay/github/callback/",
            **env,
        }
        out = io.StringIO()
        with patch.dict(os.environ, env, clear=True), patch.object(
            rc, "post_once", side_effect=responses
        ) as post, redirect_stdout(out), redirect_stderr(io.StringIO()):
            try:
                rc.main()
                code = 0
            except SystemExit as exc:
                code = exc.code
        return code, post, out.getvalue()

    def test_a_long_list_is_sent_in_chunks_and_the_outcomes_reported(self):
        n = rc.LATE_REPORT_CHUNK + 1
        code, post, out = self.run_main(
            [_report(f"job-{i}") for i in range(n)],
            [_results(*["attached"] * rc.LATE_REPORT_CHUNK), _results("attached")],
        )
        self.assertEqual(code, 0)
        self.assertEqual(post.call_count, 2)
        self.assertIn(f"{n} attached", out)

    def test_the_list_can_come_from_a_file(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json") as f:
            json.dump([_report("job-0")], f)
            f.flush()
            code, _, out = self.run_main(f"@{f.name}", [_results("attached")])
        self.assertEqual(code, 0)
        self.assertIn("1 attached", out)

    def test_a_missing_row_is_a_warning_and_an_error_fails_the_step(self):
        code, _, out = self.run_main(
            [_report("job-0"), _report("job-1")], [_results("no_such_row", "error")]
        )
        self.assertEqual(code, 1)
        self.assertIn("::warning::no_such_row", out)
        self.assertIn("::error::", out)

    def test_an_invalid_report_fails_the_step_and_says_why(self):
        body = {"results": [{"job_name": "job-0", "result": "invalid", "detail": "x"}]}
        code, _, out = self.run_main(
            [_report("job-0")], [_resp("200", json.dumps(body))]
        )
        self.assertEqual(code, 1)
        self.assertIn("::error::Invalid report, job-0 (None): x", out)

    def test_a_failed_request_does_not_stop_the_later_ones(self):
        n = rc.LATE_REPORT_CHUNK * 2
        code, post, out = self.run_main(
            [_report(f"job-{i}") for i in range(n)],
            [
                _results(*["attached"] * rc.LATE_REPORT_CHUNK),
                _resp("500", "boom"),
            ],
        )
        self.assertEqual(code, 1)
        self.assertEqual(post.call_count, 2)
        self.assertIn(f"{rc.LATE_REPORT_CHUNK} attached", out)
        self.assertIn(f"{rc.LATE_REPORT_CHUNK} failed", out)

    def test_a_hud_outage_is_called_out(self):
        # The relay answers 200 with no results when HUD is down.
        code, _, out = self.run_main([_report("job-0")], [_results()])
        self.assertEqual(code, 0)
        self.assertIn("::warning::The relay answered for 0 of 1 reports", out)

    def test_a_list_without_the_late_report_event_type_is_an_error(self):
        # Dropping it silently would lose every verdict in it.
        env = {"TRIAGE_VERDICT_LIST": json.dumps([_report("job-0")])}
        with patch.dict(os.environ, env, clear=True), patch.object(
            rc, "send_callback"
        ) as send, self.assertRaises(SystemExit) as ctx:
            rc.main()
        self.assertIn("only used with event-type", str(ctx.exception.code))
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
