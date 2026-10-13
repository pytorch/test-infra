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


if __name__ == "__main__":
    unittest.main()
