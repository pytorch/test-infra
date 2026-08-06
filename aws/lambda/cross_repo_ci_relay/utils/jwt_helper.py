"""JWT utilities for the cross-repo CI relay.

Supports multiple OIDC issuers (GitHub Actions, Buildkite) so downstream
repos running on any supported CI can authenticate callbacks.
"""

from __future__ import annotations

import logging
from typing import Dict, Optional, Tuple

import jwt
from utils.misc import HTTPException


logger = logging.getLogger(__name__)

GITHUB_ISSUER = "https://token.actions.githubusercontent.com"
BUILDKITE_ISSUER = "https://agent.buildkite.com"
AUDIENCE = "pytorch-cross-repo-ci-relay"

_ISSUER_CONFIG: Dict[str, dict] = {
    GITHUB_ISSUER: {
        "jwks_uri": f"{GITHUB_ISSUER}/.well-known/jwks",
    },
    BUILDKITE_ISSUER: {
        "jwks_uri": f"{BUILDKITE_ISSUER}/.well-known/jwks",
    },
}

_jwks_clients: Dict[str, jwt.PyJWKClient] = {
    issuer: jwt.PyJWKClient(cfg["jwks_uri"]) for issuer, cfg in _ISSUER_CONFIG.items()
}

# Runtime-populated mapping from Buildkite (org_slug, pipeline_slug) to the
# GitHub-style "owner/repo" identity.  Loaded from the ``buildkite_repos``
# section of the allowlist YAML so that adding a new Buildkite downstream
# repo only requires a config file change — no Lambda redeployment.
BUILDKITE_REPO_MAP: Dict[Tuple[str, str], str] = {}


def load_buildkite_repo_map(allowlist_raw: dict) -> None:
    """Populate ``BUILDKITE_REPO_MAP`` from the allowlist's ``buildkite_repos`` section.

    Expected YAML format in the allowlist::

        buildkite_repos:
          vllm/ci: vllm-project/vllm
          vllm/release: vllm-project/vllm

    Keys are ``org_slug/pipeline_slug``, values are ``owner/repo``.
    """
    BUILDKITE_REPO_MAP.clear()
    section = allowlist_raw.get("buildkite_repos")
    if not section or not isinstance(section, dict):
        return
    for bk_key, repo in section.items():
        bk_key_str = str(bk_key).strip()
        repo_str = str(repo).strip()
        if "/" not in bk_key_str or "/" not in repo_str:
            logger.warning("Skipping invalid buildkite_repos entry: %s -> %s", bk_key, repo)
            continue
        org, pipeline = bk_key_str.split("/", 1)
        BUILDKITE_REPO_MAP[(org, pipeline)] = repo_str
    if BUILDKITE_REPO_MAP:
        logger.info("Loaded %d Buildkite repo mappings from allowlist", len(BUILDKITE_REPO_MAP))


def _detect_issuer(token: str) -> Optional[str]:
    """Read the unverified ``iss`` claim to select the right JWKS client."""
    try:
        unverified = jwt.decode(
            token, options={"verify_signature": False, "verify_aud": False}
        )
        return unverified.get("iss")
    except Exception:
        return None


def _extract_repo_github(claims: dict) -> str:
    repo = claims.get("repository")
    if not repo:
        raise HTTPException(401, "GitHub OIDC token missing 'repository' claim")
    return repo


def _extract_repo_buildkite(claims: dict) -> str:
    org = claims.get("organization_slug", "")
    pipeline = claims.get("pipeline_slug", "")
    if not org or not pipeline:
        raise HTTPException(
            401,
            "Buildkite OIDC token missing 'organization_slug' or 'pipeline_slug'",
        )
    repo = BUILDKITE_REPO_MAP.get((org, pipeline))
    if not repo:
        raise HTTPException(
            403,
            f"Buildkite pipeline {org}/{pipeline} is not registered with CRCR",
        )
    return repo


_REPO_EXTRACTORS = {
    GITHUB_ISSUER: _extract_repo_github,
    BUILDKITE_ISSUER: _extract_repo_buildkite,
}


def verify_oidc_token(token: str) -> dict:
    """Decode an OIDC token from any supported issuer and return the claims.

    The returned dict always contains a ``repository`` key set to the
    GitHub-style ``owner/repo`` identity, regardless of the issuer.

    Raises ``HTTPException(401)`` on any verification failure.
    """
    if not token:
        raise HTTPException(401, "Missing authorization token")

    try:
        if token.lower().startswith("bearer "):
            token = token[7:].strip()

        issuer = _detect_issuer(token)
        if issuer not in _jwks_clients:
            raise HTTPException(401, f"Unsupported OIDC issuer: {issuer}")

        client = _jwks_clients[issuer]
        signing_key = client.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=issuer,
            audience=AUDIENCE,
        )

        extractor = _REPO_EXTRACTORS[issuer]
        repo = extractor(claims)
        claims["repository"] = repo

        return claims

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("OIDC token verification error")
        raise HTTPException(401, "Invalid authorization token") from exc
