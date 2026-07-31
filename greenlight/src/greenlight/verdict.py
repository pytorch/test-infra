"""One-shot recording of a PR review verdict, invoked by a privileged CI job.

Unlike the ``review`` phase this is a single action, not a daemon iteration: it runs
outside the loop, lock, and watchdog machinery and raises on any failure so the CLI
maps it straight to an exit code.

Statuses split into two modes. FULL verdicts (LAND / NO_LAND) carry a ``--verdict-file``
holding ``{status, reason, message}``; ``reason`` must be one of ``ALLOWED_REASONS`` and
``message`` must be non-empty. The command emits a gzipped single-line JSONEachRow row to
a fixed local path (the record workflow uploads it to ``s3://gha-artifacts/``, where the
clickhouse-replicator-s3 path ingests it into ``misc.greenlight_pr_state``) and then
updates GitHub with a defanged copy of the message: LAND posts an approving review,
NO_LAND dismisses greenlight's own prior approval (matched by ``bot_login``) and comments.
MARKER statuses (CANCELLED / FAILED) only emit the row -- no PR fetch, no GitHub post. The
command never writes to ClickHouse directly.
"""

from __future__ import annotations

import gzip
import json
import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from greenlight import github_client

if TYPE_CHECKING:
    from collections.abc import Callable

    from greenlight.config import Config
    from greenlight.github_client import VerdictClient

logger = logging.getLogger(__name__)

STATUS_LAND = "LAND"
STATUS_NO_LAND = "NO_LAND"
STATUS_CANCELLED = "CANCELLED"
STATUS_FAILED = "FAILED"
_FULL_STATUSES: frozenset[str] = frozenset({STATUS_LAND, STATUS_NO_LAND})
_MARKER_STATUSES: frozenset[str] = frozenset({STATUS_CANCELLED, STATUS_FAILED})
VERDICT_STATUSES: frozenset[str] = _FULL_STATUSES | _MARKER_STATUSES

# Canonical verdict reason codes. The ci-artifacts JSON schema and reviewer SKILL mirror
# this set byte-for-byte; any change here must update them in lockstep.
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

_EVAL_HASH_RE = re.compile(r"[0-9a-f]{64}")
_SUPERSEDED_MESSAGE = "Superseded by a newer greenlight verdict."
_MESSAGE_CAP = 4000
_ZERO_WIDTH_SPACE = chr(0x200B)

_S3_KEY_PREFIX = "greenlight_pr_state"
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
    if not _EVAL_HASH_RE.fullmatch(value):
        raise ValueError(f"eval_hash must be 64 lowercase hex characters, got {value!r}")


def _validate_reason(reason: str) -> None:
    if reason not in ALLOWED_REASONS:
        raise ValueError(
            f"reason {reason!r} is not an allowed verdict reason; expected one of {sorted(ALLOWED_REASONS)}"
        )


def _validate_message(message: str) -> None:
    if not message.strip():
        raise ValueError("a non-empty message is required for a LAND/NO_LAND verdict")


def _defang(text: str) -> str:
    """Render untrusted model text safe to post to GitHub.

    Caps length, neutralizes @-mentions/bot-commands with a zero-width space after each
    '@', and wraps the result in a code fence longer than any backtick run it contains so
    the content cannot break out of the block.
    """
    capped = text[:_MESSAGE_CAP]
    neutralized = capped.replace("@", "@" + _ZERO_WIDTH_SPACE)
    longest = current = 0
    for ch in neutralized:
        current = current + 1 if ch == "`" else 0
        longest = max(longest, current)
    fence = "`" * max(3, longest + 1)
    return f"{fence}\n{neutralized}\n{fence}"


def _post_body(status: str, reason: str, message: str, run_url: str) -> str:
    header = f"Green Light: {status} (reason: {reason})"
    if run_url:
        header = f"{header}\n{run_url}"
    return f"{header}\n\n{_defang(message)}"


def _object_key(repo: str, pr_number: int, version: str) -> str:
    compact = version.replace("-", "").replace(":", "").replace(" ", "T").replace(".", "_")
    return f"{_S3_KEY_PREFIX}/{repo}/{pr_number}/{compact}.json.gz"


def _emit_payload(
    request: VerdictRequest,
    status: str,
    reason: str,
    message: str,
    *,
    now: Callable[[], datetime],
    emit: Callable[[bytes, str], None],
) -> str:
    version = now().replace(tzinfo=None).isoformat(sep=" ", timespec="milliseconds")
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


def _run_marker(
    request: VerdictRequest,
    status: str,
    *,
    emit: Callable[[bytes, str], None],
    now: Callable[[], datetime],
) -> None:
    if request.dry_run:
        logger.info("[dry-run] would emit %s marker payload for %s#%d", status, request.repo, request.pr_number)
        return
    key = _emit_payload(request, status, "", "", now=now, emit=emit)
    logger.info("emitted %s marker payload for %s#%d -> %s", status, request.repo, request.pr_number, key)


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
    key = _emit_payload(request, status, reason, message, now=now, emit=emit)
    logger.info("emitted %s verdict payload for %s#%d -> %s", status, request.repo, request.pr_number, key)
    body = _post_body(status, reason, message, request.eval_job_url or request.agent_job_url)
    if status == STATUS_LAND:
        github_client.post_review(pr, event=github_client.REVIEW_EVENT_APPROVE, body=body)
        logger.info("approved %s#%d", request.repo, request.pr_number)
        return
    dismissed = github_client.dismiss_prior_greenlight_approvals(
        pr, bot_login=request.bot_login, message=_SUPERSEDED_MESSAGE
    )
    if dismissed:
        logger.info(
            "dismissed %d prior greenlight approval(s) on %s#%d", len(dismissed), request.repo, request.pr_number
        )
    github_client.create_issue_comment(pr, body)
    logger.info("posted NO_LAND comment on %s#%d", request.repo, request.pr_number)


def run(
    request: VerdictRequest,
    config: Config,
    *,
    build_github: Callable[[str], VerdictClient] = github_client.build_client,
    emit: Callable[[bytes, str], None] = _default_emit,
    now: Callable[[], datetime] = _utcnow,
) -> None:
    status, reason, message = _resolve_verdict(request)
    if status in _MARKER_STATUSES:
        _run_marker(request, status, emit=emit, now=now)
        return
    _validate_reason(reason)
    _validate_message(message)
    _validate_eval_hash(request.eval_hash)
    if status == STATUS_NO_LAND and not request.bot_login:
        raise ValueError("NO_LAND requires --bot-login to dismiss any prior greenlight approval")
    _run_full(
        request,
        config,
        status,
        reason,
        message,
        build_github=build_github,
        emit=emit,
        now=now,
    )
