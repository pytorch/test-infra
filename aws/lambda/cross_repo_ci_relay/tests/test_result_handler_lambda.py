import base64
import json
import unittest
from unittest.mock import patch

from callback.lambda_function import lambda_handler
from utils.misc import HTTPException


def _event(
    *,
    method="POST",
    path="/github/result",
    body=None,
    headers=None,
    base64_encoded=False,
):
    if body is None:
        body = json.dumps({"status": "completed", "head_sha": "abc123"})
    if base64_encoded:
        body = base64.b64encode(body.encode()).decode()
    if headers is None:
        hdrs = {"authorization": "Bearer oidc.tok"}
    else:
        hdrs = dict(headers)
    return {
        "requestContext": {"http": {"method": method, "path": path}},
        "body": body,
        "isBase64Encoded": base64_encoded,
        "headers": hdrs,
    }


class TestResultLambdaHandler(unittest.TestCase):
    def setUp(self):
        import utils.config

        utils.config._cached_config = None

    def test_route_validation(self):
        response = lambda_handler(_event(path="/other"), {})
        self.assertEqual(response["statusCode"], 404)
        response = lambda_handler(_event(method="GET"), {})
        self.assertEqual(response["statusCode"], 405)

    @patch("callback.lambda_function.get_config")
    def test_invalid_json_body_returns_400(self, mock_get_config):
        response = lambda_handler(_event(body="not-json"), {})
        self.assertEqual(response["statusCode"], 400)

    @patch("callback.lambda_function.get_config")
    def test_missing_authorization_header_returns_401(self, mock_get_config):
        response = lambda_handler(_event(headers={}), {})
        self.assertEqual(response["statusCode"], 401)
        self.assertIn("Missing", json.loads(response["body"])["detail"])

    @patch("callback.lambda_function.get_config")
    @patch("callback.lambda_function.jwt_helper.verify_oidc_token")
    def test_oidc_failure_returns_401(self, mock_oidc, mock_get_config):
        mock_oidc.side_effect = HTTPException(401, "Invalid authorization token")

        response = lambda_handler(_event(), {})

        self.assertEqual(response["statusCode"], 401)

    @patch("callback.lambda_function.get_config")
    @patch("callback.lambda_function.jwt_helper.verify_oidc_token")
    @patch("callback.lambda_function.result_handler.handle")
    def test_happy_path_forwards_body_and_verified_repo(
        self, mock_handle, mock_oidc, mock_get_config
    ):
        mock_oidc.return_value = {"repository": "org/repo"}
        mock_handle.return_value = {"ok": True, "status": "completed"}

        response = lambda_handler(_event(), {})

        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(
            json.loads(response["body"]), {"ok": True, "status": "completed"}
        )
        # Body passed through verbatim, verified_repo comes from OIDC claims.
        args = mock_handle.call_args[0]
        self.assertEqual(args[1], {"status": "completed", "head_sha": "abc123"})
        self.assertEqual(args[2], "org/repo")

    @patch("callback.lambda_function.get_config")
    @patch("callback.lambda_function.jwt_helper.verify_oidc_token")
    @patch("callback.lambda_function.result_handler.handle")
    def test_hud_error_from_handler_is_forwarded(
        self, mock_handle, mock_oidc, mock_get_config
    ):
        # HUD's HTTP status propagates out of Relay (transparent proxy).
        mock_oidc.return_value = {"repository": "org/repo"}
        mock_handle.side_effect = HTTPException(503, "HUD unreachable")

        response = lambda_handler(_event(), {})

        self.assertEqual(response["statusCode"], 503)
        self.assertEqual(json.loads(response["body"])["detail"], "HUD unreachable")

    @patch("callback.lambda_function.get_config")
    @patch("callback.lambda_function.jwt_helper.verify_oidc_token")
    @patch("callback.lambda_function.result_handler.handle")
    def test_unhandled_exception_returns_500(
        self, mock_handle, mock_oidc, mock_get_config
    ):
        mock_oidc.return_value = {"repository": "org/repo"}
        mock_handle.side_effect = Exception("boom")

        response = lambda_handler(_event(), {})

        self.assertEqual(response["statusCode"], 500)


if __name__ == "__main__":
    unittest.main()
