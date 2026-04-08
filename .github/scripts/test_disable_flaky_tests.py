#!/usr/bin/env python3
import http.server
import threading
import unittest
from unittest.mock import patch

import disable_flaky_tests


def _start_server(handler_cls: type, port: int) -> http.server.HTTPServer:
    server = http.server.HTTPServer(("127.0.0.1", port), handler_cls)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server


class TestDisableFlakyTests(unittest.TestCase):
    def _run_main(self, env: dict) -> int:
        """Run main() with the given env, return exit code (0 = success)."""
        with patch.dict("os.environ", env, clear=True):
            try:
                disable_flaky_tests.main()
                return 0
            except SystemExit as e:
                return int(e.code) if e.code is not None else 1

    def test_missing_auth_token(self):
        code = self._run_main({"X_HUD_BOT_TOKEN": "tok"})
        self.assertEqual(code, 1)

    def test_success(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, *args):
                pass

        server = _start_server(Handler, 18771)
        try:
            with patch.object(disable_flaky_tests, "HUD_URL", "http://127.0.0.1:18771"):
                code = self._run_main(
                    {"FLAKY_TEST_BOT_KEY": "key", "X_HUD_BOT_TOKEN": "tok"}
                )
            self.assertEqual(code, 0)
        finally:
            server.shutdown()

    def test_vercel_checkpoint_detected(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(
                    b"<html><title>Vercel Security Checkpoint</title></html>"
                )

            def log_message(self, *args):
                pass

        server = _start_server(Handler, 18772)
        try:
            with patch.object(disable_flaky_tests, "HUD_URL", "http://127.0.0.1:18772"):
                code = self._run_main(
                    {"FLAKY_TEST_BOT_KEY": "key", "X_HUD_BOT_TOKEN": "tok"}
                )
            self.assertEqual(code, 1)
        finally:
            server.shutdown()

    def test_http_403(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(403)
                self.end_headers()
                self.wfile.write(b"Forbidden")

            def log_message(self, *args):
                pass

        server = _start_server(Handler, 18773)
        try:
            with patch.object(disable_flaky_tests, "HUD_URL", "http://127.0.0.1:18773"):
                code = self._run_main(
                    {"FLAKY_TEST_BOT_KEY": "key", "X_HUD_BOT_TOKEN": "tok"}
                )
            self.assertEqual(code, 1)
        finally:
            server.shutdown()

    def test_http_500(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(500)
                self.end_headers()
                self.wfile.write(b"Internal Server Error")

            def log_message(self, *args):
                pass

        server = _start_server(Handler, 18774)
        try:
            with patch.object(disable_flaky_tests, "HUD_URL", "http://127.0.0.1:18774"):
                code = self._run_main(
                    {"FLAKY_TEST_BOT_KEY": "key", "X_HUD_BOT_TOKEN": "tok"}
                )
            self.assertEqual(code, 1)
        finally:
            server.shutdown()

    def test_connection_refused(self):
        with patch.object(disable_flaky_tests, "HUD_URL", "http://127.0.0.1:19999"):
            code = self._run_main(
                {"FLAKY_TEST_BOT_KEY": "key", "X_HUD_BOT_TOKEN": "tok"}
            )
        self.assertEqual(code, 1)

    def test_headers_sent(self):
        received_headers = {}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                received_headers["Authorization"] = self.headers.get("Authorization")
                received_headers["x-hud-internal-bot"] = self.headers.get(
                    "x-hud-internal-bot"
                )
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, *args):
                pass

        server = _start_server(Handler, 18775)
        try:
            with patch.object(disable_flaky_tests, "HUD_URL", "http://127.0.0.1:18775"):
                self._run_main(
                    {"FLAKY_TEST_BOT_KEY": "myauth", "X_HUD_BOT_TOKEN": "mybot"}
                )
            self.assertEqual(received_headers["Authorization"], "myauth")
            self.assertEqual(received_headers["x-hud-internal-bot"], "mybot")
        finally:
            server.shutdown()

    def test_hud_bot_token_optional(self):
        received_headers = {}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                received_headers["x-hud-internal-bot"] = self.headers.get(
                    "x-hud-internal-bot"
                )
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, *args):
                pass

        server = _start_server(Handler, 18776)
        try:
            with patch.object(disable_flaky_tests, "HUD_URL", "http://127.0.0.1:18776"):
                code = self._run_main({"FLAKY_TEST_BOT_KEY": "key"})
            self.assertEqual(code, 0)
            self.assertIsNone(received_headers["x-hud-internal-bot"])
        finally:
            server.shutdown()


if __name__ == "__main__":
    unittest.main()
