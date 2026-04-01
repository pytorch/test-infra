import hashlib
import hmac
import json
import unittest
from unittest.mock import MagicMock, patch

import lambda_function
from lambda_function import lambda_handler
from utils import HTTPException

SECRET = "test-key"
REPO = "pytorch/pytorch"


def _sign(body: bytes) -> str:
    return "sha256=" + hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()


def _cfg():
    cfg = MagicMock()
    cfg.github_app_secret = SECRET
    cfg.upstream_repo = REPO
    return cfg


def _event(*, method="POST", path="/github/webhook", body=None, headers=None):
    if body is None:
        body = json.dumps({"repository": {"full_name": REPO}, "action": "opened",
            "pull_request": {"head": {"sha": "a", "ref": "f"}, "base": {"ref": "m"}, "number": 1},
            "installation": {"id": 1}})
    hdrs = {"x-hub-signature-256": _sign(body.encode()), "x-github-event": "pull_request"}
    if headers:
        hdrs.update(headers)
    return {"requestContext": {"http": {"method": method, "path": path}},
            "body": body, "isBase64Encoded": False, "headers": hdrs}


class TestLambdaHandler(unittest.TestCase):
    def setUp(self):
        lambda_function._cached_config = None

    def test_route_error_404_and_405(self):
        self.assertEqual(lambda_handler(_event(path="/other"), None)["statusCode"], 404)
        self.assertEqual(lambda_handler(_event(method="GET"), None)["statusCode"], 405)

    @patch("lambda_function.RelayConfig.from_env")
    def test_bad_signature_401(self, mock_env):
        mock_env.return_value = _cfg()
        ev = _event(headers={"x-hub-signature-256": "sha256=bad"})
        self.assertEqual(lambda_handler(ev, None)["statusCode"], 401)

    @patch("lambda_function.RelayConfig.from_env")
    def test_success_delegates_to_handler(self, mock_env):
        mock_env.return_value = _cfg()
        mock_handle = MagicMock(return_value={"ok": True})
        with patch.dict("lambda_function._EVENT_HANDLERS", {"pull_request": mock_handle}):
            resp = lambda_handler(_event(), None)
        self.assertEqual(resp["statusCode"], 200)
        mock_handle.assert_called_once()

    @patch("lambda_function.RelayConfig.from_env")
    def test_http_exception_forwarded(self, mock_env):
        mock_env.return_value = _cfg()
        with patch.dict("lambda_function._EVENT_HANDLERS",
                        {"pull_request": MagicMock(side_effect=HTTPException(502, "err"))}):
            self.assertEqual(lambda_handler(_event(), None)["statusCode"], 502)

    @patch("lambda_function.RelayConfig.from_env")
    def test_config_cached_across_warm_invocations(self, mock_env):
        mock_env.return_value = _cfg()
        with patch.dict(
            "lambda_function._EVENT_HANDLERS",
            {"pull_request": MagicMock(return_value={"ok": True})},
        ):
            first = lambda_handler(_event(), None)
            second = lambda_handler(_event(), None)

        self.assertEqual(first["statusCode"], 200)
        self.assertEqual(second["statusCode"], 200)
        mock_env.assert_called_once()


if __name__ == "__main__":
    unittest.main()
