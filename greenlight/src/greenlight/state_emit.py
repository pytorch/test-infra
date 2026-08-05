"""Build and emit a ``misc.greenlight_pr_state`` row to S3 for replicator ingestion.

Two producers write state rows and MUST agree byte-for-byte on the JSONEachRow field
order/values and the object-key layout, or the positional S3 -> ClickHouse replicator
silently drops rows. This module is that single source: ``emit_row`` serializes the row and
``object_key`` computes its bucket-relative key. The ``verdict`` command feeds its rows
through here; the scan calls ``emit_ai_review_dispatched`` the instant it fires the reviewer
workflow, so a queued run (which can sit in GitHub's Actions queue well past a scan interval)
is recorded as in-flight immediately and never re-dispatched while it waits.

``verdict`` writes the row to a fixed local path that its workflow ``aws s3 cp``s after a
``success()`` gate; the scan has no such gate, so its default ``upload`` puts the object to
``s3://{S3_BUCKET}/{key}`` directly via boto3's default credential chain (the scan workflow's
OIDC env supplies the AWS creds at runtime).
"""

from __future__ import annotations

import gzip
import json
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Protocol, cast

from greenlight.constants import S3_BUCKET, S3_KEY_PREFIX, STATUS_AI_REVIEW_DISPATCHED

if TYPE_CHECKING:
    from collections.abc import Callable

__all__ = ["default_emit_id", "emit_ai_review_dispatched", "emit_row", "object_key"]


class _S3Putter(Protocol):
    def put_object(self, *, Bucket: str, Key: str, Body: bytes) -> object: ...  # pragma: no cover


def _utcnow() -> datetime:
    return datetime.now(UTC)


def default_emit_id() -> str:
    """The row schema's default emit-id: a fresh uuid4 hex, single-sourced for every producer."""
    return uuid.uuid4().hex


def object_key(repo: str, pr_number: int, version: str, emit_id: str) -> str:
    compact = version.replace("-", "").replace(":", "").replace(" ", "T").replace(".", "_")
    return f"{S3_KEY_PREFIX}/{repo}/{pr_number}/{compact}-{emit_id}.json.gz"


def emit_row(
    *,
    repo: str,
    pr_number: int,
    head_sha: str,
    status: str,
    reason: str,
    eval_hash: str,
    message: str,
    eval_job: str,
    agent_job: str,
    run_id: int,
    now: Callable[[], datetime],
    emit: Callable[[bytes, str], None],
    new_emit_id: Callable[[], str],
) -> str:
    """Serialize one state row as a gzipped single-line JSONEachRow and hand it to ``emit``.

    Field order and values are the replicator contract; ``emit`` receives ``(gzip_bytes, key)``
    where ``key`` is the bucket-relative object key. Returns that key for logging.
    """
    version = now().replace(tzinfo=None).isoformat(sep=" ", timespec="milliseconds")
    # emit_id is a fresh per-emit UUID that uniquifies both storage keys: the ClickHouse sort key
    # (repo, pr_number, run_id, emit_id) so the ReplacingMergeTree never collapses a row, and the
    # S3 object key so two emits for the same (repo, pr_number) in the same millisecond do not
    # overwrite each other. It is storage-only and never read back.
    emit_id = new_emit_id()
    row = {
        "repo": repo,
        "pr_number": pr_number,
        "head_sha": head_sha,
        "status": status,
        "reason": reason,
        "eval_hash": eval_hash,
        "message": message,
        "eval_job": eval_job,
        "agent_job": agent_job,
        "version": version,
        "run_id": run_id,
        "emit_id": emit_id,
    }
    line = json.dumps(row, separators=(",", ":"), ensure_ascii=False) + "\n"
    key = object_key(repo, pr_number, version, emit_id)
    emit(gzip.compress(line.encode("utf-8"), mtime=0), key)
    return key


def _s3_client() -> _S3Putter:
    import boto3
    from botocore.config import Config

    # The emit runs on the scan's main thread; without explicit bounds a hung PUT would inherit
    # botocore's 60s connect/read defaults and stall dispatch of the remaining candidates, tripping
    # the iteration timeout. Cap both and bound retries so a slow S3 fails fast instead.
    config = Config(connect_timeout=5, read_timeout=5, retries={"max_attempts": 3, "mode": "standard"})
    return cast("_S3Putter", boto3.client("s3", config=config))


def _default_upload(row_gzip: bytes, key: str) -> None:
    _s3_client().put_object(Bucket=S3_BUCKET, Key=key, Body=row_gzip)


def emit_ai_review_dispatched(
    *,
    repo: str,
    pr_number: int,
    head_sha: str,
    eval_hash: str,
    run_id: int,
    upload: Callable[[bytes, str], None] | None = None,
) -> None:
    """Emit an ``AI_REVIEW_DISPATCHED`` row the instant the scan fires the reviewer workflow.

    ``run_id`` is supplied by the caller (the scan computes the next run id); reason/message and
    the job URLs are empty, matching the ``AI_REVIEW_STARTED`` marker. ``upload`` is an injectable
    ``(gzip_bytes, key)`` seam for tests; the default puts the object via boto3.
    """
    emit_row(
        repo=repo,
        pr_number=pr_number,
        head_sha=head_sha,
        status=STATUS_AI_REVIEW_DISPATCHED,
        reason="",
        eval_hash=eval_hash,
        message="",
        eval_job="",
        agent_job="",
        run_id=run_id,
        now=_utcnow,
        emit=upload if upload is not None else _default_upload,
        new_emit_id=default_emit_id,
    )
