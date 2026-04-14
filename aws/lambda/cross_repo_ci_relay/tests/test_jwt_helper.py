import unittest
from unittest.mock import MagicMock, patch

from utils.jwt_helper import verify_oidc_token
from utils.misc import HTTPException


def _cfg():
    return MagicMock()


class TestVerifyDownstreamIdentity(unittest.TestCase):
    def setUp(self):
        self.patcher_jwks = patch(
            "utils.jwt_helper._jwks_client.get_signing_key_from_jwt"
        )
        self.mock_signing_key = self.patcher_jwks.start()
        self.mock_signing_key.return_value = MagicMock(key="fake-key")

        self.patcher_decode = patch("utils.jwt_helper.jwt.decode")
        self.mock_decode = self.patcher_decode.start()

    def tearDown(self):
        self.patcher_jwks.stop()
        self.patcher_decode.stop()

    def test_valid_token_returns_claims(self):
        expected = {
            "repository": "org/repo",
            "sub": "repo:org/repo:ref:refs/heads/main",
        }
        self.mock_decode.return_value = expected

        claims = verify_oidc_token(_cfg(), "some.oidc.token")

        self.assertEqual(claims, expected)

    def test_bearer_prefix_stripped_before_jwks_lookup(self):
        self.mock_decode.return_value = {"repository": "org/repo"}

        verify_oidc_token(_cfg(), "Bearer some.oidc.token")

        self.mock_signing_key.assert_called_once_with("some.oidc.token")

    def test_empty_token_raises_401_without_jwks_lookup(self):
        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token(_cfg(), "")
        self.assertEqual(ctx.exception.status_code, 401)
        self.assertIn("Missing", ctx.exception.detail)
        self.mock_signing_key.assert_not_called()

    def test_jwks_lookup_failure_raises_401(self):
        self.mock_signing_key.side_effect = Exception("JWKS fetch failed")

        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token(_cfg(), "bad.token")
        self.assertEqual(ctx.exception.status_code, 401)


if __name__ == "__main__":
    unittest.main()
