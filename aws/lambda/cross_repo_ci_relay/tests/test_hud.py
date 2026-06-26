import json
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

from utils.hud import forward_to_hud
from utils.misc import HTTPException


def _cfg(
    url="http://hud/api/crcr-ci-events",
    key="bot-key",
    max_retries=3,
    rate_limit_per_min=60,
):
    cfg = MagicMock()
    cfg.hud_api_url = url
    cfg.hud_bot_key = key
    cfg.hud_max_retries = max_retries
    cfg.rate_limit_per_min = rate_limit_per_min
    return cfg


class TestForwardToHud(unittest.TestCase):
    @patch("utils.hud.urllib.request.urlopen")
    def test_empty_url_skips_request(self, mock_urlopen):
        forward_to_hud(
            _cfg(url=""),
            {"ci_metrics": {}, "verified_repo": "org/repo"},
            {"callback_payload": {"delivery_id": "d"}},
        )
        mock_urlopen.assert_not_called()

    @patch("utils.hud.urllib.request.urlopen")
    def test_hud_payload_has_three_top_level_fields(self, mock_urlopen):
        resp = MagicMock()
        resp.status = 200
        mock_urlopen.return_value.__enter__.return_value = resp

        report = {"delivery_id": "d", "workflow": {"status": "completed"}}
        metrics = {"queue_time": 1.0, "execution_time": 2.0}
        forward_to_hud(
            _cfg(),
            {"ci_metrics": metrics, "verified_repo": "org/repo"},
            {"callback_payload": report},
        )

        sent = json.loads(mock_urlopen.call_args[0][0].data)
        self.assertEqual(sent["trusted"]["ci_metrics"], metrics)
        self.assertEqual(sent["trusted"]["verified_repo"], "org/repo")
        self.assertEqual(sent["untrusted"]["callback_payload"], report)

    @patch("utils.hud.urllib.request.urlopen")
    def test_bot_key_sent_as_internal_bot_header(self, mock_urlopen):
        # HUD identifies internal-bot traffic by the x-hud-internal-bot header
        # and exempts it from rate limiting; the relay must send the bot key
        # under that header so its callbacks are not throttled (HTTP 429).
        resp = MagicMock()
        resp.status = 200
        mock_urlopen.return_value.__enter__.return_value = resp

        forward_to_hud(
            _cfg(key="secret-bot-key"),
            {"ci_metrics": {}, "verified_repo": "org/repo"},
            {"callback_payload": {}},
        )

        req = mock_urlopen.call_args[0][0]
        self.assertEqual(req.get_header("X-hud-internal-bot"), "secret-bot-key")

    @patch("utils.hud.urllib.request.urlopen")
    def test_4xx_propagates_with_huds_status(self, mock_urlopen):
        # 4xx means the caller sent bad data — propagate so the downstream
        # workflow author sees a red step.
        mock_urlopen.side_effect = urllib.error.HTTPError(
            "http://hud", 422, "bad schema", {}, None
        )

        with self.assertRaises(HTTPException) as ctx:
            forward_to_hud(
                _cfg(),
                {"ci_metrics": {}, "verified_repo": "org/repo"},
                {"callback_payload": {}},
            )
        self.assertEqual(ctx.exception.status_code, 422)

    @patch("utils.hud.time.sleep")
    @patch("utils.hud.urllib.request.urlopen")
    def test_retries_exhausted(self, mock_urlopen, mock_sleep):
        """5xx and URLError are retried; after exhaustion an exception is raised."""
        cases = [
            (
                urllib.error.HTTPError("http://hud", 500, "err", {}, None),
                HTTPException,
                500,
            ),
            (urllib.error.URLError("unreachable"), urllib.error.URLError, None),
        ]
        for exc, expected_type, expected_code in cases:
            with self.subTest(exc=exc):
                mock_urlopen.reset_mock()
                mock_sleep.reset_mock()
                mock_urlopen.side_effect = exc

                with self.assertRaises(expected_type) as ctx:
                    forward_to_hud(
                        _cfg(max_retries=2),
                        {"ci_metrics": {}, "verified_repo": "org/repo"},
                        {"callback_payload": {}},
                    )
                if expected_code is not None:
                    self.assertEqual(ctx.exception.status_code, expected_code)
                self.assertEqual(mock_urlopen.call_count, 3)  # 1 + 2 retries
                self.assertEqual(mock_sleep.call_count, 2)

    @patch("utils.hud.time.sleep")
    @patch("utils.hud.urllib.request.urlopen")
    def test_5xx_succeeds_on_retry(self, mock_urlopen, mock_sleep):
        mock_urlopen.side_effect = [
            urllib.error.HTTPError("http://hud", 500, "unavailable", {}, None),
            MagicMock(status=200),
        ]
        forward_to_hud(
            _cfg(),
            {"ci_metrics": {}, "verified_repo": "org/repo"},
            {"callback_payload": {}},
        )
        self.assertEqual(mock_urlopen.call_count, 2)
        self.assertEqual(mock_sleep.call_count, 1)


if __name__ == "__main__":
    unittest.main()
