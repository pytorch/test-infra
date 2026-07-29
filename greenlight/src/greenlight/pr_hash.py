"""Deterministic, non-cryptographic PR fingerprint hashing (the eval_hash land-guard)."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any

HASH_SCHEME_VERSION = 1

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


def is_bot(login: str, user_type: str | None = None) -> bool:
    if user_type is not None and user_type.lower() == "bot":
        return True
    normalized_login = login.lower()
    if normalized_login.endswith("[bot]"):
        return True
    return normalized_login in BOT_LOGINS


@dataclass(frozen=True, slots=True)
class ChangedFile:
    path: str
    status: str
    blob_sha: str
    previous_path: str | None = None


@dataclass(frozen=True, slots=True)
class HumanEvent:
    kind: str
    id: int
    author: str
    body: str
    state: str | None
    timestamp: str


@dataclass(frozen=True, slots=True)
class PRFingerprint:
    base_sha: str
    changed_files: tuple[ChangedFile, ...]
    human_events: tuple[HumanEvent, ...]
    scheme_version: int = HASH_SCHEME_VERSION


def _canonical(item: dict[str, Any]) -> str:
    return json.dumps(item, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def compute_pr_hash(fingerprint: PRFingerprint) -> str:
    payload = {
        "scheme_version": fingerprint.scheme_version,
        "base_sha": fingerprint.base_sha,
        "changed_files": sorted((asdict(f) for f in fingerprint.changed_files), key=_canonical),
        "human_events": sorted((asdict(e) for e in fingerprint.human_events), key=_canonical),
    }
    data = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return hashlib.md5(data, usedforsecurity=False).hexdigest()
