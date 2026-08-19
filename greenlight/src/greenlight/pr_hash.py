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

Bot-command comments/reviews are excluded too: any comment or review whose body contains a
bot-command @-mention (see ``BOT_COMMAND_MENTIONS`` / ``is_bot_command``) is dropped whole, so a
trusted author's ``@pytorchbot merge`` never perturbs the digest. This is part of the same
byte-identical cross-process contract -- the land-time verifier MUST import ``is_bot_command`` and
MUST NOT reimplement it, or its digest diverges and it refuses every land.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any

HASH_SCHEME_VERSION = 6

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

# Lowercase; ``@pytorchbot`` is NOT a substring of ``@pytorchmergebot``, so both are listed.
BOT_COMMAND_MENTIONS: frozenset[str] = frozenset(
    {
        "@pytorchbot",
        "@pytorchmergebot",
        "@claude",
        "@greenlight",
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


def is_bot_command(body: str | None) -> bool:
    if not body:
        return False
    normalized_body = body.lower()
    return any(mention in normalized_body for mention in BOT_COMMAND_MENTIONS)


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
