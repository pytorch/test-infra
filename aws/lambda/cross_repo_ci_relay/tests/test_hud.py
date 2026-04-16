import json
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

from utils.hud import forward_to_hud
from utils.misc import HTTPException


def _cfg(url="http://hud/api/oot-ci-events", key="bot-key"):
    cfg = MagicMock()
    cfg.hud_api_url = url
    cfg.hud_bot_key = key
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

    @patch("utils.hud.urllib.request.urlopen")
    def test_5xx_is_swallowed(self, mock_urlopen):
        # 5xx is HUD's own problem — don't turn every downstream CI red.
        mock_urlopen.side_effect = urllib.error.HTTPError(
            "http://hud", 503, "unavailable", {}, None
        )

        # must not raise
        forward_to_hud(
            _cfg(),
            {"ci_metrics": {}, "verified_repo": "org/repo"},
            {"callback_payload": {}},
        )

    @patch("utils.hud.urllib.request.urlopen")
    def test_url_error_is_swallowed(self, mock_urlopen):
        # Network-level failure (DNS, timeout, connection refused) is
        # infrastructure, not a caller bug.
        mock_urlopen.side_effect = urllib.error.URLError("unreachable")

        # must not raise
        forward_to_hud(
            _cfg(),
            {"ci_metrics": {}, "verified_repo": "org/repo"},
            {"callback_payload": {}},
        )


if __name__ == "__main__":
    unittest.main()
