"""Deterministic PR fingerprint hashing (the eval_hash land-guard).

SHA-256 over a canonical JSON payload: a collision-resistant content fingerprint,
not a secrecy mechanism. This module is the single source of truth for the
fingerprint. The writer (greenlight) and the land-time verifier (pytorchbot) both
import it and compute a byte-identical digest; a mismatch means the verifier
refuses to land. ``scheme_version`` is part of the hashed payload, so any change to
the payload, its canonicalization, or the hash algorithm MUST bump
``HASH_SCHEME_VERSION`` and add a new golden test that pins the new digest.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any

HASH_SCHEME_VERSION = 3

BOT_LOGINS: frozenset[str] = frozenset(
    {
        "pytorchbot",
        "pytorch-bot",
        "pytorchmergebot",
        "pytorchupdatebot",
        "github-actions",
        "dependabot",
        "facebook-github-bot",
        "facebook-github-tools",
        "meta-codesync",
        "codecov",
        "codecov-commenter",
        "linux-foundation-easycla",
    }
)


def is_bot(login: str | None, user_type: str | None = None) -> bool:
    if user_type is not None and user_type.lower() == "bot":
        return True
    if not login:
        return False
    normalized_login = login.lower()
    if normalized_login.endswith("[bot]"):
        return True
    return normalized_login in BOT_LOGINS


@dataclass(frozen=True, slots=True)
class HumanEvent:
    id: int
    body: str


@dataclass(frozen=True, slots=True)
class PRFingerprint:
    base_sha: str
    head_sha: str
    human_events: tuple[HumanEvent, ...]
    scheme_version: int = HASH_SCHEME_VERSION


def _canonical(item: dict[str, Any]) -> str:
    return json.dumps(item, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def compute_pr_hash(fingerprint: PRFingerprint) -> str:
    payload = {
        "scheme_version": fingerprint.scheme_version,
        "base_sha": fingerprint.base_sha,
        "head_sha": fingerprint.head_sha,
        "human_events": sorted((asdict(e) for e in fingerprint.human_events), key=_canonical),
    }
    data = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(data).hexdigest()
