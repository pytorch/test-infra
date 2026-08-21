"""JWT utilities for the cross-repo CI relay.

Supports multiple OIDC issuers so downstream repos running on any
supported CI can authenticate callbacks.

Trust anchors (issuer URLs and JWKS endpoints) are compiled into this
module.  The runtime-fetched ci_providers.yml supplies only mutable
authorization data — repo mappings for providers that lack a native
"repository" claim (e.g., Buildkite).
"""

from __future__ import annotations

import logging
from typing import Dict, Optional, Tuple
from urllib.parse import urlparse

import jwt
import yaml
from utils.misc import HTTPException


logger = logging.getLogger(__name__)

AUDIENCE = "pytorch-cross-repo-ci-relay"

GITHUB_ISSUER = "https://token.actions.githubusercontent.com"
BUILDKITE_ISSUER = "https://agent.buildkite.com"

_jwks_clients: Dict[str, jwt.PyJWKClient] = {
    GITHUB_ISSUER: jwt.PyJWKClient(f"{GITHUB_ISSUER}/.well-known/jwks"),
    BUILDKITE_ISSUER: jwt.PyJWKClient(f"{BUILDKITE_ISSUER}/.well-known/jwks"),
}

# Runtime-populated mapping from Buildkite (organization_id, pipeline_id) to
# the GitHub-style "owner/repo" identity plus optional required claims.
# Uses immutable IDs rather than slugs to prevent identity hijacking via slug
# rename.  Loaded from ci_providers.yml so adding a new downstream repo only
# requires a config change — no Lambda redeployment.
#
# Values are dicts: {"repo": "owner/repo", "required_claims": {...}}
# required_claims maps claim_name -> list of allowed values (any match passes).
BUILDKITE_REPO_MAP: Dict[Tuple[str, str], dict] = {}


def _load_buildkite_repo_map(repo_map: dict) -> None:
    """Parse a repo_map dict into BUILDKITE_REPO_MAP entries."""
    for bk_key, value in repo_map.items():
        bk_key_str = str(bk_key).strip()
        if "/" not in bk_key_str:
            logger.warning("Skipping buildkite entry without /: %s", bk_key)
            continue
        org, pipeline = bk_key_str.split("/", 1)

        if isinstance(value, str):
            repo_str = value.strip()
            if "/" not in repo_str:
                logger.warning(
                    "Skipping invalid buildkite entry: %s -> %s", bk_key, value
                )
                continue
            BUILDKITE_REPO_MAP[(org, pipeline)] = {
                "repo": repo_str,
                "required_claims": {},
            }
        elif isinstance(value, dict):
            repo_str = str(value.get("repo", "")).strip()
            if "/" not in repo_str:
                logger.warning("Skipping buildkite entry with invalid repo: %s", bk_key)
                continue
            required = value.get("required_claims", {})
            if not isinstance(required, dict):
                required = {}
            normalized = {}
            for k, v in required.items():
                if isinstance(v, list):
                    normalized[k] = [str(x) for x in v]
                else:
                    normalized[k] = [str(v)]
            BUILDKITE_REPO_MAP[(org, pipeline)] = {
                "repo": repo_str,
                "required_claims": normalized,
            }


def load_ci_provider_mappings(raw: dict) -> None:
    """Populate repo maps from ci_providers.yml.

    Only mutable authorization data (Buildkite pipeline-to-repo
    mappings) is loaded from config.  Trust anchors (issuer URLs,
    JWKS endpoints) are compiled into this module and cannot be
    overridden at runtime.

    Supports both the new ``providers.buildkite.repo_map`` format
    and the legacy flat ``buildkite:`` section.
    """
    BUILDKITE_REPO_MAP.clear()

    providers = raw.get("providers")
    if providers and isinstance(providers, dict):
        bk = providers.get("buildkite")
        if bk and isinstance(bk, dict):
            repo_map = bk.get("repo_map")
            if repo_map and isinstance(repo_map, dict):
                _load_buildkite_repo_map(repo_map)

    if not BUILDKITE_REPO_MAP:
        bk_section = raw.get("buildkite")
        if bk_section and isinstance(bk_section, dict):
            _load_buildkite_repo_map(bk_section)

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
    """Load CI provider config from the configured URL, with Redis caching."""
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
    entry = BUILDKITE_REPO_MAP.get((org_id, pipeline_id))
    if not entry:
        raise HTTPException(
            403,
            f"Buildkite pipeline {org_id}/{pipeline_id} is not registered with CRCR",
        )

    for claim_name, allowed_values in entry["required_claims"].items():
        actual = str(claims.get(claim_name, ""))
        if actual not in allowed_values:
            raise HTTPException(
                403,
                f"Buildkite claim '{claim_name}' value '{actual}' "
                f"not in allowed set for this pipeline",
            )

    return entry["repo"]


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

        detected_issuer = _detect_issuer(token)
        if detected_issuer not in _jwks_clients:
            raise HTTPException(401, f"Unsupported OIDC issuer: {detected_issuer}")

        client = _jwks_clients[detected_issuer]
        signing_key = client.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=detected_issuer,
            audience=AUDIENCE,
        )

        verified_issuer = claims.get("iss", "")
        if verified_issuer != detected_issuer:
            raise HTTPException(
                401,
                f"Issuer mismatch: token claims '{verified_issuer}' "
                f"but was routed as '{detected_issuer}'",
            )

        extractor = _REPO_EXTRACTORS.get(detected_issuer)
        if not extractor:
            raise HTTPException(401, f"No repo extractor for issuer: {detected_issuer}")
        repo = extractor(claims)
        claims["repository"] = repo

        return claims

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("OIDC token verification error")
        raise HTTPException(401, "Invalid authorization token") from exc
