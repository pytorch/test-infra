"""Shared constants for the greenlight service: verdict statuses, storage keys, and dispatch targets."""

from __future__ import annotations

import re

STATUS_LAND = "LAND"
STATUS_NO_LAND = "NO_LAND"
STATUS_CANCELLED = "CANCELLED"
STATUS_FAILED = "FAILED"
STATUS_AI_REVIEW_STARTED = "AI_REVIEW_STARTED"
STATUS_AI_REVIEW_DISPATCHED = "AI_REVIEW_DISPATCHED"

TERMINAL_STATUSES: frozenset[str] = frozenset({STATUS_LAND, STATUS_NO_LAND})
IN_FLIGHT_STATUSES: frozenset[str] = frozenset({STATUS_AI_REVIEW_STARTED, STATUS_AI_REVIEW_DISPATCHED})
RETRY_STATUSES: frozenset[str] = frozenset({STATUS_CANCELLED, STATUS_FAILED})
# AI_REVIEW_DISPATCHED is written only by the scan (via state_emit's direct S3 emit) and must stay
# in IN_FLIGHT_STATUSES so decide() treats a queued run as in-flight; but it is never an accepted
# verdict status, so it is subtracted out of the emittable set the verdict CLI validates against.
SCAN_ONLY_STATUSES: frozenset[str] = frozenset({STATUS_AI_REVIEW_DISPATCHED})
VERDICT_STATUSES: frozenset[str] = (TERMINAL_STATUSES | IN_FLIGHT_STATUSES | RETRY_STATUSES) - SCAN_ONLY_STATUSES

# GitHub labels are case-sensitive; the pytorch stale bot uses the exact name "Stale".
STALE_LABEL = "Stale"
EXCLUDED_LABELS: frozenset[str] = frozenset({STALE_LABEL})

# The reviewer and record workflows already write greenlight state rows to this bucket via
# ``aws s3 cp``; the scan's direct boto3 upload targets the same bucket, single-sourced here.
S3_BUCKET = "gha-artifacts"
S3_KEY_PREFIX = "greenlight_pr_state"
EVAL_HASH_RE = re.compile(r"[0-9a-f]{64}")
HEAD_SHA_RE = re.compile(r"[0-9a-fA-F]{40}")

TARGET_REPO = "pytorch/pytorch"
DISPATCH_REPO = "pytorch/test-infra"
WORKFLOW_FILE = "greenlight-pr-review.yml"
DEFAULT_DISPATCH_REF = "main"
DEFAULT_TIMEOUT_MINUTES = 45

MERGE_RULES_PATH = ".github/merge_rules.yaml"

DRCI_ENDPOINT = "https://hud.pytorch.org/api/drci/drci"


def normalize_repo(repo: str) -> str:
    """Fold an ``owner/name`` into the canonical key both sides of the Dr. CI gate match on.

    GitHub resolves ``owner/name`` case-insensitively, so the two gates must agree on one key:
    were greenlight to suppress on a differently-cased repo that the HUD's own list then missed,
    the PR would show no status at all. ``greenlightRepoKey`` in
    ``torchci/lib/greenlight/greenlightConfig.ts`` mirrors this rule and must keep doing so.
    """
    return repo.strip().lower()


# Repos where Dr. CI is capable of rendering greenlight's recorded state inside its own comment.
# This is only the repo half of the suppression gate: greenlight drops its own status comment
# (and pokes DRCI_ENDPOINT instead) only when the repo is listed here AND
# Config.drci_renders_status_comment says the Dr. CI side is switched on. Membership alone must
# never suppress, or a repo whose Dr. CI render is off would show no status anywhere.
# Entries are folded at construction, so a mixed-case addition cannot silently never match.
DRCI_STATUS_COMMENT_REPOS: frozenset[str] = frozenset(normalize_repo(repo) for repo in (TARGET_REPO,))

# A GitHub App acts through a bot account whose login is ``<app-slug>[bot]``. Both the verdict
# writer and the scan's recheck-refusal poster author-scope their comment writes to this login,
# so it must be App-shaped or a copied marker in a third party's comment could be hijacked.
BOT_LOGIN_SUFFIX = "[bot]"


def is_app_login(value: str) -> bool:
    """True when ``value`` is a GitHub App login of the form ``<slug>[bot]`` with a non-empty slug."""
    return value.endswith(BOT_LOGIN_SUFFIX) and len(value) > len(BOT_LOGIN_SUFFIX)


def delegates_status_comment_to_drci(repo: str) -> bool:
    """True when ``repo`` is one whose greenlight status Dr. CI can render in its own comment.

    The repo half of the suppression gate only; callers must also require
    ``Config.drci_renders_status_comment``.
    """
    return normalize_repo(repo) in DRCI_STATUS_COMMENT_REPOS


def validate_eval_hash(value: str) -> None:
    if not EVAL_HASH_RE.fullmatch(value):
        raise ValueError(f"eval_hash must be 64 lowercase hex characters, got {value!r}")


def validate_head_sha(value: str) -> None:
    if not HEAD_SHA_RE.fullmatch(value):
        raise ValueError(f"head_sha must be a 40-character hex commit sha, got {value!r}")
