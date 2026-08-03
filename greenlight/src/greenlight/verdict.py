"""One-shot recording of a PR review verdict, invoked by a privileged CI job.

Unlike the ``review`` phase this is a single action, not a daemon iteration: it runs
outside the loop, lock, and watchdog machinery and raises on any failure so the CLI
maps it straight to an exit code.

Statuses split into two modes. FULL verdicts (LAND / NO_LAND) carry a ``--verdict-file``
holding ``{status, reason, message}``; ``reason`` must be one of ``ALLOWED_REASONS`` and
``message`` must be non-empty. The command emits a gzipped single-line JSONEachRow row to
a fixed local path (the record workflow uploads it to ``s3://gha-artifacts/``, where the
clickhouse-replicator-s3 path ingests it into ``misc.greenlight_pr_state``) and then
updates GitHub with a defanged copy of the message. Both LAND and NO_LAND upsert one
canonical verdict comment -- edited in place across runs, found by a hidden marker and
restricted to greenlight's own account (``bot_login``); LAND additionally posts an approving
review, and NO_LAND additionally dismisses greenlight's own prior approval (matched by
``bot_login``). The row is authoritative, so the comment upsert is best-effort on every path (a
failed write is logged and swallowed); the LAND approving review and the NO_LAND dismissal are the
merge gate and stay load-bearing -- they raise on failure. MARKER statuses (CANCELLED / FAILED /
AI_REVIEW_STARTED) always emit the row and, when a ``bot_login`` and token are both present,
best-effort upsert that same canonical comment to show the run as in-progress (AI_REVIEW_STARTED)
or not-completed (CANCELLED / FAILED). The command never writes to ClickHouse directly.
"""

from __future__ import annotations

import gzip
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from greenlight import comment_format, constants, github_client
from greenlight.constants import (
    IN_FLIGHT_STATUSES,
    RETRY_STATUSES,
    S3_KEY_PREFIX,
    STATUS_LAND,
    TERMINAL_STATUSES,
    VERDICT_STATUSES,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from greenlight.config import Config
    from greenlight.github_client import VerdictClient, VerdictPR

__all__ = ["ALLOWED_REASONS", "VERDICT_STATUSES", "VerdictRequest", "run"]

logger = logging.getLogger(__name__)

_FULL_STATUSES = TERMINAL_STATUSES
_MARKER_STATUSES = RETRY_STATUSES | IN_FLIGHT_STATUSES

# Canonical verdict reason codes. Three files mirror this set byte-for-byte:
# .claude/hooks/greenlight/verdict-schema.json, .claude/hooks/greenlight/validate-on-stop.sh,
# and .claude/skills/greenlight-review/SKILL.md; agreement is enforced by
# greenlight/tests/test_reason_enum_sync.py.
ALLOWED_REASONS: frozenset[str] = frozenset(
    {
        "clean",
        "possible_regression",
        "removed_safety_logic",
        "insufficient_tests",
        "scope_too_large",
        "unclear_intent",
        "security_risk",
        "breaking_change",
        "build_or_ci_risk",
        "injection_attempt",
        "review_error",
    }
)

_SUPERSEDED_MESSAGE = "Superseded by a newer greenlight verdict."

# The APPROVE review is the merge gate; its body is intentionally empty so it adds no text on
# top of the canonical verdict comment, which already states the outcome.
_LAND_REVIEW_BODY = ""

# Fixed paths are the contract with the record workflow, which `aws s3 cp`s the row file
# to the bucket-relative key. Constant on purpose; tests inject a fake emit instead.
_ROW_PATH = "/tmp/greenlight-verdict-row.json.gz"  # noqa: S108
_KEY_PATH = "/tmp/greenlight-verdict-key.txt"  # noqa: S108


@dataclass(frozen=True, slots=True)
class VerdictRequest:
    repo: str
    pr_number: int
    head_sha: str
    eval_hash: str = ""
    status: str | None = None
    verdict_file: str | None = None
    agent_job_url: str = ""
    eval_job_url: str = ""
    bot_login: str = ""
    run_id: int | None = None
    dry_run: bool = False


@dataclass(frozen=True, slots=True)
class _VerdictDoc:
    status: str | None
    reason: str
    message: str


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _str_field(data: dict[str, object], key: str, path: str) -> str:
    value = data.get(key, "")
    if not isinstance(value, str):
        raise ValueError(f"verdict file {path} field {key!r} must be a string")
    return value


def _optional_str_field(data: dict[str, object], key: str, path: str) -> str | None:
    value = data.get(key)
    if value is not None and not isinstance(value, str):
        raise ValueError(f"verdict file {path} field {key!r} must be a string")
    return value


def _load_verdict_file(path: str) -> _VerdictDoc:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        raise ValueError(f"cannot read verdict file {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"verdict file {path} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"verdict file {path} must contain a JSON object")
    return _VerdictDoc(
        status=_optional_str_field(data, "status", path),
        reason=_str_field(data, "reason", path),
        message=_str_field(data, "message", path),
    )


def _resolve_verdict(request: VerdictRequest) -> tuple[str, str, str]:
    cli_status = request.status.strip().upper() if request.status else None
    # A marker status given on the CLI needs no verdict file at all.
    if cli_status in _MARKER_STATUSES:
        return cli_status, "", ""
    doc = _load_verdict_file(request.verdict_file) if request.verdict_file else None
    raw_status = cli_status or (doc.status if doc else None)
    if not raw_status:
        raise ValueError("a verdict status is required: pass --status or a --verdict-file containing 'status'")
    status = raw_status.strip().upper()
    if status in _MARKER_STATUSES:
        return status, "", ""
    if status in _FULL_STATUSES:
        if doc is None:
            raise ValueError(f"{status} requires --verdict-file for its reason and message")
        return status, doc.reason, doc.message
    raise ValueError(f"unknown verdict status {status!r}; expected one of {sorted(VERDICT_STATUSES)}")


def _validate_eval_hash(value: str) -> None:
    constants.validate_eval_hash(value)


def _validate_reason(reason: str) -> None:
    if reason not in ALLOWED_REASONS:
        raise ValueError(
            f"reason {reason!r} is not an allowed verdict reason; expected one of {sorted(ALLOWED_REASONS)}"
        )


def _validate_message(message: str) -> None:
    if not message.strip():
        raise ValueError("a non-empty message is required for a LAND/NO_LAND verdict")


def _object_key(repo: str, pr_number: int, version: str) -> str:
    compact = version.replace("-", "").replace(":", "").replace(" ", "T").replace(".", "_")
    return f"{S3_KEY_PREFIX}/{repo}/{pr_number}/{compact}.json.gz"


def _emit_payload(
    request: VerdictRequest,
    status: str,
    reason: str,
    message: str,
    *,
    now: Callable[[], datetime],
    emit: Callable[[bytes, str], None],
    new_emit_id: Callable[[], str],
) -> str:
    version = now().replace(tzinfo=None).isoformat(sep=" ", timespec="milliseconds")
    # emit_id is a fresh per-emit UUID whose only job is to make the ClickHouse sort key
    # (repo, pr_number, run_id, emit_id) unique so the ReplacingMergeTree never collapses a
    # row; it is storage-only and never read back.
    row = {
        "repo": request.repo,
        "pr_number": request.pr_number,
        "head_sha": request.head_sha,
        "status": status,
        "reason": reason,
        "eval_hash": request.eval_hash,
        "message": message,
        "eval_job": request.eval_job_url,
        "agent_job": request.agent_job_url,
        "version": version,
        "run_id": request.run_id or 0,
        "emit_id": new_emit_id(),
    }
    line = json.dumps(row, separators=(",", ":"), ensure_ascii=False) + "\n"
    key = _object_key(request.repo, request.pr_number, version)
    emit(gzip.compress(line.encode("utf-8"), mtime=0), key)
    return key


def _default_emit(row_gzip: bytes, key: str) -> None:
    with open(_ROW_PATH, "wb") as fh:
        fh.write(row_gzip)
    with open(_KEY_PATH, "w", encoding="utf-8") as fh:
        fh.write(key)


def _best_effort_upsert(
    request: VerdictRequest,
    config: Config,
    body: str,
    *,
    build_github: Callable[[str], VerdictClient],
    pr: VerdictPR | None = None,
) -> None:
    """Upsert the canonical verdict comment as a best-effort, cosmetic write.

    The emitted row is authoritative; the comment is cosmetic. A raise here would fail the CLI
    and skip the workflow's ``success()``-gated S3 upload, losing the row -- so any failure is
    logged and swallowed. ``pr`` is reused when the caller already fetched it for a load-bearing
    action (the LAND review / NO_LAND dismiss); otherwise the client and PR are fetched here so a
    transient fetch failure is swallowed too.
    """
    try:
        if pr is None:
            if not config.github_token:
                return
            client = build_github(config.github_token)
            pr = github_client.get_pr(client, request.repo, request.pr_number)
        github_client.upsert_issue_comment(
            pr,
            marker=comment_format.COMMENT_MARKER,
            body=body,
            author_login=request.bot_login,
            run_id=request.run_id,
        )
    except Exception as exc:
        logger.error("Failed to upsert verdict comment for PR #%s: %s", request.pr_number, exc, exc_info=True)
    else:
        logger.info("upserted verdict comment on %s#%d", request.repo, request.pr_number)


def _run_marker(
    request: VerdictRequest,
    config: Config,
    status: str,
    *,
    build_github: Callable[[str], VerdictClient],
    emit: Callable[[bytes, str], None],
    now: Callable[[], datetime],
    new_emit_id: Callable[[], str],
) -> None:
    if request.dry_run:
        logger.info("[dry-run] would emit %s marker payload for %s#%d", status, request.repo, request.pr_number)
        return
    key = _emit_payload(request, status, "", "", now=now, emit=emit, new_emit_id=new_emit_id)
    logger.info("emitted %s marker payload for %s#%d -> %s", status, request.repo, request.pr_number, key)
    if not request.bot_login:
        return
    body = comment_format.marker_body(status, request.agent_job_url or request.eval_job_url, request.run_id)
    _best_effort_upsert(request, config, body, build_github=build_github)


def _run_full(
    request: VerdictRequest,
    config: Config,
    status: str,
    reason: str,
    message: str,
    *,
    build_github: Callable[[str], VerdictClient],
    emit: Callable[[bytes, str], None],
    now: Callable[[], datetime],
    new_emit_id: Callable[[], str],
) -> None:
    # --dry-run stays fully offline: no token, no GitHub fetch, no payload written.
    if request.dry_run:
        logger.info(
            "[dry-run] would emit %s (reason: %s) for %s#%d and post to GitHub",
            status,
            reason,
            request.repo,
            request.pr_number,
        )
        return
    token = config.github_token
    if not token:
        raise ValueError("PYTORCH_GREENLIGHT_GITHUB_TOKEN is required to post a verdict")
    client = build_github(token)
    pr = github_client.get_pr(client, request.repo, request.pr_number)
    key = _emit_payload(request, status, reason, message, now=now, emit=emit, new_emit_id=new_emit_id)
    logger.info("emitted %s verdict payload for %s#%d -> %s", status, request.repo, request.pr_number, key)
    job_url = request.agent_job_url or request.eval_job_url
    body = comment_format.verdict_body(status, reason, message, job_url, request.run_id)
    if status == STATUS_LAND:
        github_client.post_review(pr, event=github_client.REVIEW_EVENT_APPROVE, body=_LAND_REVIEW_BODY)
        logger.info("approved %s#%d", request.repo, request.pr_number)
        _best_effort_upsert(request, config, body, build_github=build_github, pr=pr)
        return
    dismissed = github_client.dismiss_prior_greenlight_approvals(
        pr, bot_login=request.bot_login, message=_SUPERSEDED_MESSAGE
    )
    if dismissed:
        logger.info(
            "dismissed %d prior greenlight approval(s) on %s#%d", len(dismissed), request.repo, request.pr_number
        )
    else:
        logger.info("no prior greenlight approval to dismiss on %s#%d", request.repo, request.pr_number)
    _best_effort_upsert(request, config, body, build_github=build_github, pr=pr)


def run(
    request: VerdictRequest,
    config: Config,
    *,
    build_github: Callable[[str], VerdictClient] = github_client.build_client,
    emit: Callable[[bytes, str], None] = _default_emit,
    now: Callable[[], datetime] = _utcnow,
    new_emit_id: Callable[[], str] = lambda: uuid.uuid4().hex,
) -> None:
    status, reason, message = _resolve_verdict(request)
    if status in _MARKER_STATUSES:
        _run_marker(request, config, status, build_github=build_github, emit=emit, now=now, new_emit_id=new_emit_id)
        return
    _validate_reason(reason)
    _validate_message(message)
    _validate_eval_hash(request.eval_hash)
    if status in TERMINAL_STATUSES and not request.bot_login:
        raise ValueError(
            "LAND/NO_LAND requires --bot-login (author-scopes the verdict comment upsert; "
            "NO_LAND also dismisses prior greenlight approvals)"
        )
    if status in TERMINAL_STATUSES and not constants.is_app_login(request.bot_login):
        raise ValueError(
            f"LAND/NO_LAND --bot-login must be a GitHub App login of the form <app-slug>{constants.BOT_LOGIN_SUFFIX}, "
            f"got {request.bot_login!r}"
        )
    _run_full(
        request,
        config,
        status,
        reason,
        message,
        build_github=build_github,
        emit=emit,
        now=now,
        new_emit_id=new_emit_id,
    )
