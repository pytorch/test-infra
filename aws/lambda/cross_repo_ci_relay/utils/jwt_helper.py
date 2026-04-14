"""JWT utilities for the cross-repo CI relay."""

from __future__ import annotations

import logging

import jwt
from utils.config import RelayConfig
from utils.misc import HTTPException


logger = logging.getLogger(__name__)

_jwks_client = jwt.PyJWKClient(
    "https://token.actions.githubusercontent.com/.well-known/jwks"
)


def verify_oidc_token(config: RelayConfig, token: str) -> dict:
    """Decode a GitHub Actions OIDC token and return the claims.

    Rejects an empty/missing token up front so every call site gets a uniform
    401 without repeating the check.  Raises ``HTTPException(401)`` on any
    verification failure.
    """
    if not token:
        raise HTTPException(401, "Missing authorization token")

    try:
        if token.lower().startswith("bearer "):
            token = token[7:].strip()

        signing_key = _jwks_client.get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer="https://token.actions.githubusercontent.com",
            options={"verify_aud": False},
        )
    except Exception as exc:
        logger.exception("OIDC token verification error")
        raise HTTPException(401, "Invalid authorization token") from exc
