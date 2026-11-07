import unittest
from unittest.mock import MagicMock, patch

from utils.jwt_helper import (
    _jwks_clients,
    AUDIENCE,
    BUILDKITE_ISSUER,
    BUILDKITE_REPO_MAP,
    GITHUB_ISSUER,
    LATE_REPORT_DELEGATES,
    load_ci_provider_mappings,
    resolve_reporting_repo,
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

    def test_no_mappings_loaded_names_the_config_source(self):
        # A relay that loaded no mappings at all is a deployment problem, not a
        # missing ci_providers.yml entry; the 403 has to say which one it is.
        BUILDKITE_REPO_MAP.clear()
        self.mock_decode.return_value = _fake_buildkite_claims()
        with self.assertRaises(HTTPException) as ctx:
            verify_oidc_token("bk.oidc.token")
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("CI_PROVIDERS_URL", ctx.exception.detail)
        self.assertNotIn("not registered", ctx.exception.detail)

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

    def test_loads_valid_buildkite_entries_legacy(self):
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

    def test_loads_constrained_entries_legacy(self):
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
        self.assertEqual(entry["required_claims"]["build_branch"], ["main", "nightly"])
        self.assertEqual(entry["required_claims"]["cluster_id"], ["cluster-uuid"])

    def test_providers_section_loads_repo_map(self):
        raw = {
            "providers": {
                "buildkite": {
                    "repo_map": {
                        "org-id/pipe-id": "vllm-project/vllm",
                    },
                },
            }
        }
        load_ci_provider_mappings(raw)
        self.assertEqual(
            BUILDKITE_REPO_MAP[("org-id", "pipe-id")]["repo"], "vllm-project/vllm"
        )

    def test_providers_section_loads_constrained_repo_map(self):
        raw = {
            "providers": {
                "buildkite": {
                    "repo_map": {
                        "org-id/pipe-id": {
                            "repo": "myorg/myrepo",
                            "required_claims": {"build_branch": ["main"]},
                        },
                    },
                },
            }
        }
        load_ci_provider_mappings(raw)
        entry = BUILDKITE_REPO_MAP[("org-id", "pipe-id")]
        self.assertEqual(entry["repo"], "myorg/myrepo")
        self.assertEqual(entry["required_claims"]["build_branch"], ["main"])

    def test_providers_ignores_issuer_jwks_fields(self):
        """Config may still contain issuer/jwks_uri for documentation but they
        are ignored — trust anchors are compiled in."""
        raw = {
            "providers": {
                "buildkite": {
                    "issuer": "https://evil.example.com",
                    "jwks_uri": "https://evil.example.com/.well-known/jwks",
                    "repo_map": {
                        "org-id/pipe-id": "vllm-project/vllm",
                    },
                },
            }
        }
        load_ci_provider_mappings(raw)
        self.assertNotIn("https://evil.example.com", _jwks_clients)
        self.assertEqual(
            BUILDKITE_REPO_MAP[("org-id", "pipe-id")]["repo"], "vllm-project/vllm"
        )

    def test_empty_config_clears_map(self):
        BUILDKITE_REPO_MAP[("old", "entry")] = {
            "repo": "old/repo",
            "required_claims": {},
        }
        load_ci_provider_mappings({})
        self.assertEqual(len(BUILDKITE_REPO_MAP), 0)

    def test_missing_buildkite_section_clears_map(self):
        BUILDKITE_REPO_MAP[("old", "entry")] = {
            "repo": "old/repo",
            "required_claims": {},
        }
        load_ci_provider_mappings({"gitlab": {"group/proj": "org/repo"}})
        self.assertEqual(len(BUILDKITE_REPO_MAP), 0)

    def test_skips_invalid_entries(self):
        raw = {
            "buildkite": {"noslash": "vllm-project/vllm", "ok-id/pipe-id": "ok/repo"}
        }
        load_ci_provider_mappings(raw)
        self.assertNotIn(("noslash", ""), BUILDKITE_REPO_MAP)
        self.assertEqual(BUILDKITE_REPO_MAP[("ok-id", "pipe-id")]["repo"], "ok/repo")

    def test_legacy_fallback_when_providers_has_no_repo_map(self):
        """If providers section exists but has no buildkite repo_map,
        fall back to legacy flat buildkite section."""
        raw = {
            "providers": {"github": {}},
            "buildkite": {"org-id/pipe-id": "legacy/repo"},
        }
        load_ci_provider_mappings(raw)
        self.assertEqual(
            BUILDKITE_REPO_MAP[("org-id", "pipe-id")]["repo"], "legacy/repo"
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


class TestTrustAnchorsCompiledIn(unittest.TestCase):
    """Verify that JWKS clients are hardcoded and not modifiable via config."""

    def test_jwks_clients_contain_known_issuers(self):
        self.assertIn(GITHUB_ISSUER, _jwks_clients)
        self.assertIn(BUILDKITE_ISSUER, _jwks_clients)

    def test_jwks_clients_not_expandable_via_config(self):
        """Loading config with a rogue issuer must not add a JWKS client."""
        fake_issuer = "https://rogue.example.com"
        raw = {
            "providers": {
                "rogue": {
                    "issuer": fake_issuer,
                    "jwks_uri": f"{fake_issuer}/.well-known/jwks",
                    "repo_map": {"org/pipe": "owner/repo"},
                },
            }
        }
        load_ci_provider_mappings(raw)
        self.assertNotIn(fake_issuer, _jwks_clients)


TRIAGE_WORKFLOW = (
    "pytorch/test-infra/.github/workflows/vllm-torch-nightly-triage.yml@refs/heads/main"
)


def _delegate(**overrides):
    entry = {
        "repository": "pytorch/test-infra",
        "job_workflow_ref": TRIAGE_WORKFLOW,
        "on_behalf_of": "vllm-project/vllm",
    }
    entry.update(overrides)
    return entry


def _load_delegates(*entries):
    load_ci_provider_mappings(
        {"providers": {"github": {"late_report_delegates": list(entries)}}}
    )


class TestLateReportDelegates(unittest.TestCase):
    def setUp(self):
        self.addCleanup(LATE_REPORT_DELEGATES.clear)
        _load_delegates(_delegate())

    def _claims(self, **overrides):
        return _fake_github_claims(
            **{
                "repository": "pytorch/test-infra",
                "job_workflow_ref": TRIAGE_WORKFLOW,
                **overrides,
            }
        )

    def test_late_report_from_the_delegate_reports_for_the_other_repo(self):
        self.assertEqual(
            resolve_reporting_repo(self._claims(), "late-report"), "vllm-project/vllm"
        )

    def test_other_events_from_the_delegate_stay_its_own(self):
        for event in ("", "nightly", "periodic", "workflow_run"):
            with self.subTest(event):
                self.assertEqual(
                    resolve_reporting_repo(self._claims(), event), "pytorch/test-infra"
                )

    def test_another_workflow_of_the_same_repo_is_not_a_delegate(self):
        claims = self._claims(
            job_workflow_ref="pytorch/test-infra/.github/workflows/other.yml"
            "@refs/heads/main"
        )
        self.assertEqual(
            resolve_reporting_repo(claims, "late-report"), "pytorch/test-infra"
        )

    def test_the_workflow_on_another_ref_is_not_a_delegate(self):
        for ref in ("refs/heads/my-branch", "refs/pull/1/merge", "refs/tags/v1"):
            with self.subTest(ref):
                claims = self._claims(
                    job_workflow_ref=TRIAGE_WORKFLOW.replace("refs/heads/main", ref)
                )
                self.assertEqual(
                    resolve_reporting_repo(claims, "late-report"),
                    "pytorch/test-infra",
                )

    def test_a_fork_with_the_same_workflow_is_not_a_delegate(self):
        claims = self._claims()
        claims["repository"] = "someone/test-infra"
        self.assertEqual(
            resolve_reporting_repo(claims, "late-report"), "someone/test-infra"
        )

    def test_a_token_without_job_workflow_ref_is_not_a_delegate(self):
        # Buildkite tokens have no job_workflow_ref.
        claims = {"repository": "pytorch/test-infra"}
        self.assertEqual(
            resolve_reporting_repo(claims, "late-report"), "pytorch/test-infra"
        )

    def test_nobody_is_a_delegate_without_config(self):
        LATE_REPORT_DELEGATES.clear()
        self.assertEqual(
            resolve_reporting_repo(self._claims(), "late-report"), "pytorch/test-infra"
        )

    def test_reloading_the_config_replaces_the_delegates(self):
        load_ci_provider_mappings({})
        self.assertEqual(LATE_REPORT_DELEGATES, [])

    def test_incomplete_or_unpinned_entries_are_skipped(self):
        _load_delegates(
            _delegate(on_behalf_of=""),
            _delegate(repository="test-infra"),
            _delegate(on_behalf_of="vllm"),
            # No ref: would trust every version of the workflow.
            _delegate(job_workflow_ref="pytorch/test-infra/.github/workflows/x.yml"),
            "not-a-map",
        )
        self.assertEqual(LATE_REPORT_DELEGATES, [])


if __name__ == "__main__":
    unittest.main()
