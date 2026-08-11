import unittest
from unittest.mock import MagicMock, patch

from utils.jwt_helper import (
    AUDIENCE,
    BUILDKITE_ISSUER,
    BUILDKITE_REPO_MAP,
    GITHUB_ISSUER,
    load_ci_provider_mappings,
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
        "organization_id": "org-uuid-123",
        "pipeline_id": "pipe-uuid-456",
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

    def test_cross_issuer_token_rejected(self):
        """A GitHub-signed token asserting iss=buildkite must be rejected."""
        self.mock_detect.return_value = GITHUB_ISSUER
        self.mock_decode.return_value = {
            "iss": BUILDKITE_ISSUER,
            "repository": "org/repo",
        }
        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token("cross.issuer.token")
        self.assertEqual(ctx.exception.status_code, 401)
        self.assertIn("Issuer mismatch", ctx.exception.detail)


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
        load_ci_provider_mappings(
            {"buildkite": {"org-uuid-123/pipe-uuid-456": "myorg/myrepo"}}
        )

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
            organization_id="unknown-org", pipeline_id="unknown-pipe"
        )
        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token("bk.oidc.token")
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("not registered", ctx.exception.detail)

    def test_missing_org_id_raises_401(self):
        self.mock_decode.return_value = _fake_buildkite_claims(organization_id="")
        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token("bk.oidc.token")
        self.assertEqual(ctx.exception.status_code, 401)

    def test_missing_pipeline_id_raises_401(self):
        self.mock_decode.return_value = _fake_buildkite_claims(pipeline_id="")
        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token("bk.oidc.token")
        self.assertEqual(ctx.exception.status_code, 401)

    def test_buildkite_uses_correct_audience(self):
        self.mock_decode.return_value = _fake_buildkite_claims()

        verify_oidc_token("bk.oidc.token")

        self.assertEqual(self.mock_decode.call_args.kwargs["audience"], AUDIENCE)

    def test_required_claims_pass_when_matching(self):
        load_ci_provider_mappings(
            {
                "buildkite": {
                    "org-uuid-123/pipe-uuid-456": {
                        "repo": "myorg/myrepo",
                        "required_claims": {"build_branch": ["main", "nightly"]},
                    }
                }
            }
        )
        self.mock_decode.return_value = _fake_buildkite_claims(build_branch="main")
        claims = verify_oidc_token("bk.oidc.token")
        self.assertEqual(claims["repository"], "myorg/myrepo")

    def test_required_claims_reject_disallowed_branch(self):
        load_ci_provider_mappings(
            {
                "buildkite": {
                    "org-uuid-123/pipe-uuid-456": {
                        "repo": "myorg/myrepo",
                        "required_claims": {"build_branch": ["main", "nightly"]},
                    }
                }
            }
        )
        self.mock_decode.return_value = _fake_buildkite_claims(
            build_branch="fork-pr-branch"
        )
        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token("bk.oidc.token")
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("build_branch", ctx.exception.detail)

    def test_required_claims_reject_missing_claim(self):
        load_ci_provider_mappings(
            {
                "buildkite": {
                    "org-uuid-123/pipe-uuid-456": {
                        "repo": "myorg/myrepo",
                        "required_claims": {"cluster_id": ["cluster-abc"]},
                    }
                }
            }
        )
        self.mock_decode.return_value = _fake_buildkite_claims()
        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token("bk.oidc.token")
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("cluster_id", ctx.exception.detail)


class TestLoadCIProviderMappings(unittest.TestCase):
    """Tests for loading CI provider repo mappings from ci_providers.yml."""

    def setUp(self):
        self._orig_map = BUILDKITE_REPO_MAP.copy()

    def tearDown(self):
        BUILDKITE_REPO_MAP.clear()
        BUILDKITE_REPO_MAP.update(self._orig_map)

    def test_loads_valid_buildkite_entries(self):
        raw = {
            "buildkite": {
                "org-id-1/pipe-id-1": "vllm-project/vllm",
                "org-id-2/pipe-id-2": "acme/repo",
            }
        }
        load_ci_provider_mappings(raw)
        self.assertEqual(
            BUILDKITE_REPO_MAP[("org-id-1", "pipe-id-1")]["repo"],
            "vllm-project/vllm",
        )
        self.assertEqual(
            BUILDKITE_REPO_MAP[("org-id-2", "pipe-id-2")]["repo"], "acme/repo"
        )

    def test_loads_constrained_entries(self):
        raw = {
            "buildkite": {
                "org-id/pipe-id": {
                    "repo": "myorg/myrepo",
                    "required_claims": {
                        "build_branch": ["main", "nightly"],
                        "cluster_id": "cluster-uuid",
                    },
                }
            }
        }
        load_ci_provider_mappings(raw)
        entry = BUILDKITE_REPO_MAP[("org-id", "pipe-id")]
        self.assertEqual(entry["repo"], "myorg/myrepo")
        self.assertEqual(
            entry["required_claims"]["build_branch"], ["main", "nightly"]
        )
        self.assertEqual(entry["required_claims"]["cluster_id"], ["cluster-uuid"])

    def test_empty_config_clears_map(self):
        BUILDKITE_REPO_MAP[("old", "entry")] = {"repo": "old/repo", "required_claims": {}}
        load_ci_provider_mappings({})
        self.assertEqual(len(BUILDKITE_REPO_MAP), 0)

    def test_missing_buildkite_section_clears_map(self):
        BUILDKITE_REPO_MAP[("old", "entry")] = {"repo": "old/repo", "required_claims": {}}
        load_ci_provider_mappings({"gitlab": {"group/proj": "org/repo"}})
        self.assertEqual(len(BUILDKITE_REPO_MAP), 0)

    def test_skips_invalid_entries(self):
        raw = {
            "buildkite": {"noslash": "vllm-project/vllm", "ok-id/pipe-id": "ok/repo"}
        }
        load_ci_provider_mappings(raw)
        self.assertNotIn(("noslash", ""), BUILDKITE_REPO_MAP)
        self.assertEqual(
            BUILDKITE_REPO_MAP[("ok-id", "pipe-id")]["repo"], "ok/repo"
        )


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
