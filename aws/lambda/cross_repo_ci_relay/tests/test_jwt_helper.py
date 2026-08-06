import unittest
from unittest.mock import MagicMock, patch

from utils.jwt_helper import (
    AUDIENCE,
    BUILDKITE_ISSUER,
    BUILDKITE_REPO_MAP,
    GITHUB_ISSUER,
    verify_oidc_token,
)
from utils.misc import HTTPException


def _fake_github_claims(**overrides):
    base = {
        "iss": GITHUB_ISSUER,
        "repository": "org/repo",
        "sub": "repo:org/repo:ref:refs/heads/main",
    }
    base.update(overrides)
    return base


def _fake_buildkite_claims(**overrides):
    base = {
        "iss": BUILDKITE_ISSUER,
        "organization_slug": "myorg",
        "pipeline_slug": "mypipeline",
        "build_commit": "abc123",
        "build_number": "42",
    }
    base.update(overrides)
    return base


class TestVerifyGitHubOIDC(unittest.TestCase):
    """Tests for GitHub Actions OIDC tokens (existing behaviour)."""

    def setUp(self):
        self.patcher_detect = patch("utils.jwt_helper._detect_issuer")
        self.mock_detect = self.patcher_detect.start()
        self.mock_detect.return_value = GITHUB_ISSUER

        self.patcher_jwks = patch("utils.jwt_helper._jwks_clients")
        self.mock_clients = self.patcher_jwks.start()
        self.mock_client = MagicMock()
        self.mock_client.get_signing_key_from_jwt.return_value = MagicMock(
            key="fake-key"
        )
        self.mock_clients.__contains__ = lambda s, k: k in (
            GITHUB_ISSUER,
            BUILDKITE_ISSUER,
        )
        self.mock_clients.__getitem__ = lambda s, k: self.mock_client

        self.patcher_decode = patch("utils.jwt_helper.jwt.decode")
        self.mock_decode = self.patcher_decode.start()

    def tearDown(self):
        self.patcher_detect.stop()
        self.patcher_jwks.stop()
        self.patcher_decode.stop()

    def test_valid_github_token_returns_claims(self):
        expected = _fake_github_claims()
        self.mock_decode.return_value = expected

        claims = verify_oidc_token("some.oidc.token")

        self.assertEqual(claims["repository"], "org/repo")
        self.mock_decode.assert_called_once()
        self.assertEqual(self.mock_decode.call_args.kwargs["audience"], AUDIENCE)
        self.assertEqual(self.mock_decode.call_args.kwargs["issuer"], GITHUB_ISSUER)

    def test_wrong_audience_raises_401(self):
        import jwt as _jwt

        self.mock_decode.side_effect = _jwt.InvalidAudienceError("bad aud")
        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token("token.with.wrong.aud")
        self.assertEqual(ctx.exception.status_code, 401)

    def test_bearer_prefix_stripped(self):
        self.mock_decode.return_value = _fake_github_claims()

        verify_oidc_token("Bearer some.oidc.token")

        self.mock_client.get_signing_key_from_jwt.assert_called_once_with(
            "some.oidc.token"
        )

    def test_empty_token_raises_401(self):
        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token("")
        self.assertEqual(ctx.exception.status_code, 401)
        self.assertIn("Missing", ctx.exception.detail)

    def test_jwks_lookup_failure_raises_401(self):
        self.mock_client.get_signing_key_from_jwt.side_effect = Exception(
            "JWKS fetch failed"
        )
        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token("bad.token")
        self.assertEqual(ctx.exception.status_code, 401)

    def test_github_token_missing_repository_claim_raises_401(self):
        self.mock_decode.return_value = {"iss": GITHUB_ISSUER, "sub": "..."}
        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token("token.no.repo")
        self.assertEqual(ctx.exception.status_code, 401)


class TestVerifyBuildkiteOIDC(unittest.TestCase):
    """Tests for Buildkite OIDC tokens."""

    def setUp(self):
        self.patcher_detect = patch("utils.jwt_helper._detect_issuer")
        self.mock_detect = self.patcher_detect.start()
        self.mock_detect.return_value = BUILDKITE_ISSUER

        self.patcher_jwks = patch("utils.jwt_helper._jwks_clients")
        self.mock_clients = self.patcher_jwks.start()
        self.mock_client = MagicMock()
        self.mock_client.get_signing_key_from_jwt.return_value = MagicMock(
            key="fake-key"
        )
        self.mock_clients.__contains__ = lambda s, k: k in (
            GITHUB_ISSUER,
            BUILDKITE_ISSUER,
        )
        self.mock_clients.__getitem__ = lambda s, k: self.mock_client

        self.patcher_decode = patch("utils.jwt_helper.jwt.decode")
        self.mock_decode = self.patcher_decode.start()

        self._orig_map = BUILDKITE_REPO_MAP.copy()
        BUILDKITE_REPO_MAP[("myorg", "mypipeline")] = "myorg/myrepo"

    def tearDown(self):
        self.patcher_detect.stop()
        self.patcher_jwks.stop()
        self.patcher_decode.stop()
        BUILDKITE_REPO_MAP.clear()
        BUILDKITE_REPO_MAP.update(self._orig_map)

    def test_valid_buildkite_token_returns_mapped_repo(self):
        self.mock_decode.return_value = _fake_buildkite_claims()

        claims = verify_oidc_token("bk.oidc.token")

        self.assertEqual(claims["repository"], "myorg/myrepo")
        self.mock_decode.assert_called_once()
        self.assertEqual(self.mock_decode.call_args.kwargs["issuer"], BUILDKITE_ISSUER)

    def test_unregistered_pipeline_raises_403(self):
        self.mock_decode.return_value = _fake_buildkite_claims(
            organization_slug="unknown", pipeline_slug="unknown"
        )
        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token("bk.oidc.token")
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("not registered", ctx.exception.detail)

    def test_missing_org_slug_raises_401(self):
        self.mock_decode.return_value = _fake_buildkite_claims(organization_slug="")
        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token("bk.oidc.token")
        self.assertEqual(ctx.exception.status_code, 401)

    def test_missing_pipeline_slug_raises_401(self):
        self.mock_decode.return_value = _fake_buildkite_claims(pipeline_slug="")
        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token("bk.oidc.token")
        self.assertEqual(ctx.exception.status_code, 401)

    def test_buildkite_uses_correct_audience(self):
        self.mock_decode.return_value = _fake_buildkite_claims()

        verify_oidc_token("bk.oidc.token")

        self.assertEqual(self.mock_decode.call_args.kwargs["audience"], AUDIENCE)


class TestUnsupportedIssuer(unittest.TestCase):
    """Tests for tokens from unsupported issuers."""

    def setUp(self):
        self.patcher_detect = patch("utils.jwt_helper._detect_issuer")
        self.mock_detect = self.patcher_detect.start()

    def tearDown(self):
        self.patcher_detect.stop()

    def test_unknown_issuer_raises_401(self):
        self.mock_detect.return_value = "https://evil.example.com"
        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token("evil.token")
        self.assertEqual(ctx.exception.status_code, 401)
        self.assertIn("Unsupported OIDC issuer", ctx.exception.detail)

    def test_none_issuer_raises_401(self):
        self.mock_detect.return_value = None
        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token("garbage.token")
        self.assertEqual(ctx.exception.status_code, 401)


if __name__ == "__main__":
    unittest.main()
