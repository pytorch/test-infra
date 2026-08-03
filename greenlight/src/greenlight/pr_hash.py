"""Deterministic PR fingerprint hashing (the eval_hash land-guard).

SHA-256 over a canonical JSON payload: a collision-resistant content fingerprint,
not a secrecy mechanism. This module is the single source of truth for the
fingerprint. The writer (greenlight) and the land-time verifier (pytorchbot) both
import it and compute a byte-identical digest; a mismatch means the verifier
refuses to land. ``scheme_version`` is part of the hashed payload, so any change to
the payload, its canonicalization, or the hash algorithm MUST bump
``HASH_SCHEME_VERSION`` and add a new golden test that pins the new digest.

Which comments feed the hash is a cross-process contract too: the writer keeps only
events authored by pytorch/pytorch's merge-authorized set (see ``merge_authz`` and
``github_client.build_pr_fingerprint``), so the land-time verifier MUST resolve that
same set the same way -- via ``merge_authz.resolve_authorized_logins``, which lowercases
every login and unions ALL merge_rules entries. It MUST NOT reuse pytorch's
``trymerge.py`` authorization check: that is case-sensitive and scoped to the rules whose
file patterns match a single PR, so its set diverges from this full lowercased union and
yields a different digest -- refusing every land.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any

HASH_SCHEME_VERSION = 5

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
    head_sha: str
    human_events: tuple[HumanEvent, ...]
    scheme_version: int = HASH_SCHEME_VERSION


def _canonical(item: dict[str, Any]) -> str:
    return json.dumps(item, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def compute_pr_hash(fingerprint: PRFingerprint) -> str:
    payload = {
        "scheme_version": fingerprint.scheme_version,
        "head_sha": fingerprint.head_sha,
        "human_events": sorted((asdict(e) for e in fingerprint.human_events), key=_canonical),
    }
    data = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(data).hexdigest()
