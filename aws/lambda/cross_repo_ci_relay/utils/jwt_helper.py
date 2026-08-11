"""JWT utilities for the cross-repo CI relay.

Supports multiple OIDC issuers (GitHub Actions, Buildkite) so downstream
repos running on any supported CI can authenticate callbacks.
"""

from __future__ import annotations

import logging
from typing import Dict, Optional, Tuple
from urllib.parse import urlparse

import jwt
import yaml
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

# Runtime-populated mapping from Buildkite (organization_id, pipeline_id) to
# the GitHub-style "owner/repo" identity.  Uses immutable IDs rather than
# slugs to prevent identity hijacking via slug rename.  Loaded from
# ci_providers.yml so adding a new downstream repo only requires a config
# change — no Lambda redeployment.
BUILDKITE_REPO_MAP: Dict[Tuple[str, str], str] = {}


def load_ci_provider_mappings(raw: dict) -> None:
    """Populate provider repo maps from parsed ci_providers.yml content.

    Currently supports ``buildkite``.  Adding a new provider means adding
    a new section reader here and a corresponding ``_extract_repo_*``
    function below.
    """
    BUILDKITE_REPO_MAP.clear()
    bk_section = raw.get("buildkite")
    if bk_section and isinstance(bk_section, dict):
        for bk_key, repo in bk_section.items():
            bk_key_str = str(bk_key).strip()
            repo_str = str(repo).strip()
            if "/" not in bk_key_str or "/" not in repo_str:
                logger.warning(
                    "Skipping invalid buildkite entry: %s -> %s", bk_key, repo
                )
                continue
            org, pipeline = bk_key_str.split("/", 1)
            BUILDKITE_REPO_MAP[(org, pipeline)] = repo_str
    if BUILDKITE_REPO_MAP:
        logger.info(
            "Loaded %d Buildkite repo mapping(s) from ci_providers",
            len(BUILDKITE_REPO_MAP),
        )


def _fetch_github_file(url: str) -> str:
    """Fetch a file from a GitHub blob URL without authentication."""
    from utils import gh_helper

    parsed = urlparse(url)
    parts = [p for p in parsed.path.split("/") if p]
    if (
        parsed.scheme not in ("http", "https")
        or parsed.netloc != "github.com"
        or len(parts) < 5
        or parts[2] != "blob"
    ):
        raise RuntimeError(
            f"Invalid GitHub URL {url!r}. "
            "Expected: https://github.com/<owner>/<repo>/blob/<ref>/<path>"
        )
    owner, repo, _blob, ref, *file_parts = parts
    return gh_helper.get_repo_file(owner, repo, "/".join(file_parts), ref)


def load_ci_providers(config) -> None:
    """Load CI provider mappings from the configured URL, with Redis caching.

    ``config`` is a ``RelayConfig`` instance (imported lazily to avoid
    pulling heavy dependencies at module-import time during testing).
    """
    if not config.ci_providers_url:
        return

    from utils import redis_helper

    yaml_str = redis_helper.get_cached_ci_providers(config)
    if yaml_str is None:
        logger.info(
            "ci_providers cache miss - loading from %s", config.ci_providers_url
        )
        yaml_str = _fetch_github_file(config.ci_providers_url)
        redis_helper.set_cached_ci_providers(config, yaml_str)
    raw = yaml.safe_load(yaml_str) or {}
    load_ci_provider_mappings(raw)


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
    org_id = claims.get("organization_id", "")
    pipeline_id = claims.get("pipeline_id", "")
    if not org_id or not pipeline_id:
        raise HTTPException(
            401,
            "Buildkite OIDC token missing 'organization_id' or 'pipeline_id'",
        )
    repo = BUILDKITE_REPO_MAP.get((org_id, pipeline_id))
    if not repo:
        raise HTTPException(
            403,
            f"Buildkite pipeline {org_id}/{pipeline_id} is not registered with CRCR",
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
