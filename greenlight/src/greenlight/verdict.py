"""One-shot recording of a PR review verdict, invoked by a privileged CI job.

Unlike the ``review`` phase this is a single action, not a daemon iteration: it runs
outside the loop, lock, and watchdog machinery and raises on any failure so the CLI
maps it straight to an exit code.

Statuses split into two modes. FULL verdicts (LAND / NO_LAND) carry a ``--verdict-file``
holding ``{status, reason, message}``; ``reason`` must be one of ``ALLOWED_REASONS`` -- and
exactly ``constants.LAND_REASON`` when the status is LAND -- while ``message`` must be
non-empty. The command emits a gzipped single-line JSONEachRow row to
a fixed local path (the record workflow uploads it to ``s3://gha-artifacts/``, where the
clickhouse-replicator-s3 path ingests it into ``misc.greenlight_pr_state``) and then
updates GitHub with a defanged copy of the message. Both LAND and NO_LAND upsert one
canonical verdict comment -- edited in place across runs, found by a hidden marker and
restricted to greenlight's own account (``bot_login``); LAND additionally posts an approving
review unless the verdict is shadow or greenlight already holds a live approval on the PR, and
NO_LAND additionally dismisses greenlight's own prior approval (both matched by ``bot_login``).
A shadow verdict carries no authority, and that is absolute rather than forward-looking: no
approving review is ever posted for one, any prior greenlight approval is dismissed on the LAND
path as well as the NO_LAND one, and the row is stamped ``shadow`` so neither Dr. CI nor the merge
gate reads it. Withholding a new approval would not take back one the author collected before
leaving the trusted set, and a live approval is authority whatever the row says. The row is
authoritative, so the comment upsert is best-effort on every path (a
failed write is logged and swallowed); the LAND approving review and the NO_LAND dismissal are the
merge gate and stay load-bearing -- they raise on failure. MARKER statuses (CANCELLED / FAILED /
AI_REVIEW_STARTED) always emit the row and, when a ``bot_login`` and token are both present,
best-effort upsert that same canonical comment to show the run as in-progress (AI_REVIEW_STARTED)
or not-completed (CANCELLED / FAILED). The command never writes to ClickHouse directly.

Every comment upsert above is suppressed on the repos in ``constants.DRCI_STATUS_COMMENT_REPOS``,
where Dr. CI renders the same state from the emitted row and the ``drci-poke`` command refreshes
that render instead. Everywhere else greenlight posts the comment itself, so no PR is left with a
recorded verdict and no visible status. The row emit, the LAND approving review, and the NO_LAND
dismissal are unaffected on every repo.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from greenlight import cohort, comment_format, constants, github_client, redact, state_emit, verdict_input
from greenlight.constants import ALLOWED_REASONS, STATUS_LAND, TERMINAL_STATUSES, VERDICT_STATUSES

if TYPE_CHECKING:
    from collections.abc import Callable

    from greenlight.config import Config
    from greenlight.github_types import VerdictClient, VerdictPR


__all__ = ["ALLOWED_REASONS", "VERDICT_STATUSES", "VerdictRequest", "run"]

logger = logging.getLogger(__name__)

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
    shadow: bool = False
    dry_run: bool = False


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _emit_payload(
    request: VerdictRequest,
    status: str,
    reason: str,
    message: str,
    *,
    shadow: bool,
    now: Callable[[], datetime],
    emit: Callable[[bytes, str], None],
    new_emit_id: Callable[[], str],
) -> str:
    # run_id is optional on the request but a non-null Int64 in the row; None -> 0 (a JSON null
    # would fail the replicator). The row schema and object key live in state_emit.
    return state_emit.emit_row(
        repo=request.repo,
        pr_number=request.pr_number,
        head_sha=request.head_sha,
        status=status,
        reason=reason,
        eval_hash=request.eval_hash,
        message=message,
        eval_job=request.eval_job_url,
        agent_job=request.agent_job_url,
        run_id=request.run_id or 0,
        shadow=shadow,
        now=now,
        emit=emit,
        new_emit_id=new_emit_id,
    )


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

    Skipped entirely on the repos Dr. CI renders (``constants.delegates_status_comment_to_drci``),
    because Dr. CI shows the same state from the emitted row and the ``drci-poke`` command
    refreshes that render instead.

    The emitted row is authoritative; the comment is cosmetic. A raise here would fail the CLI
    and skip the workflow's ``success()``-gated S3 upload, losing the row -- so any failure is
    logged and swallowed. ``pr`` is reused when the caller already fetched it for a load-bearing
    action (the LAND review / NO_LAND dismiss); otherwise the client and PR are fetched here so a
    transient fetch failure is swallowed too.
    """
    if constants.delegates_status_comment_to_drci(request.repo):
        logger.info("Dr. CI renders the status comment on %s; skipping upsert", request.repo)
        return
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
    # Markers take request.shadow verbatim and never look the author up. Both jobs that reach here
    # mint the App token with continue-on-error, so a lookup can fail, and fail-closed derivation
    # would hide a trusted author's in-flight marker from the merge gate -- a WAIT, then a DENY.
    key = _emit_payload(request, status, "", "", shadow=request.shadow, now=now, emit=emit, new_emit_id=new_emit_id)
    logger.info("emitted %s marker payload for %s#%d -> %s", status, request.repo, request.pr_number, key)
    if not request.bot_login:
        return
    body = comment_format.marker_body(status, request.agent_job_url or request.eval_job_url, request.run_id)
    _best_effort_upsert(request, config, body, build_github=build_github)


def _dismiss_prior_approvals(request: VerdictRequest, pr: VerdictPR) -> None:
    dismissed = github_client.dismiss_prior_greenlight_approvals(
        pr, bot_login=request.bot_login, message=_SUPERSEDED_MESSAGE
    )
    if dismissed:
        logger.info(
            "dismissed %d prior greenlight approval(s) on %s#%d", len(dismissed), request.repo, request.pr_number
        )
    else:
        logger.info("no prior greenlight approval to dismiss on %s#%d", request.repo, request.pr_number)


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
    author = pr.user.login if pr.user is not None else None
    # OR, never AND: the caller's value and this one are derived independently, so a disagreement
    # means the approval was withheld. Stamping the row non-shadow anyway would render a LAND in
    # Dr. CI and offer the merge gate an authorization that no review backs.
    shadow = request.shadow or cohort.is_shadow(author)
    key = _emit_payload(request, status, reason, message, shadow=shadow, now=now, emit=emit, new_emit_id=new_emit_id)
    logger.info("emitted %s verdict payload for %s#%d -> %s", status, request.repo, request.pr_number, key)
    job_url = request.agent_job_url or request.eval_job_url
    body = comment_format.verdict_body(
        status,
        reason,
        message,
        job_url,
        request.run_id,
        comment_format.report_url(request.repo, request.pr_number, request.head_sha),
    )
    if status == STATUS_LAND:
        if shadow:
            logger.info(
                "shadow verdict on %s#%d (author %r, requested shadow=%s); withholding approval",
                request.repo,
                request.pr_number,
                author,
                request.shadow,
            )
            # A shadow PR must never carry a live greenlight approval. Under merge_rules.yaml's
            # wildcard Greenlight Review Bot rule one approval authorizes a merge of any path in
            # the repo, so an approval held from before the author left the trusted set is still
            # authority -- withholding a new one does not take the old one back.
            _dismiss_prior_approvals(request, pr)
        elif github_client.has_live_greenlight_approval(pr, bot_login=request.bot_login):
            logger.info("already approved %s#%d; skipping re-approval", request.repo, request.pr_number)
        else:
            github_client.post_review(pr, event=github_client.REVIEW_EVENT_APPROVE, body=_LAND_REVIEW_BODY)
            logger.info("approved %s#%d", request.repo, request.pr_number)
        _best_effort_upsert(request, config, body, build_github=build_github, pr=pr)
        return
    _dismiss_prior_approvals(request, pr)
    _best_effort_upsert(request, config, body, build_github=build_github, pr=pr)


def run(
    request: VerdictRequest,
    config: Config,
    *,
    build_github: Callable[[str], VerdictClient] = github_client.build_client,
    emit: Callable[[bytes, str], None] = _default_emit,
    now: Callable[[], datetime] = _utcnow,
    new_emit_id: Callable[[], str] = state_emit.default_emit_id,
) -> None:
    status, reason, message = verdict_input._resolve_verdict(request)
    if status in verdict_input._MARKER_STATUSES:
        _run_marker(request, config, status, build_github=build_github, emit=emit, now=now, new_emit_id=new_emit_id)
        return
    # Single scrub point: the model message fans out to the ClickHouse row (_emit_payload) and the
    # GitHub comment (verdict_body/defang) below, so redact secrets here to cover both sinks once.
    message = redact.scrub_secrets(message)
    verdict_input._validate_reason(status, reason)
    verdict_input._validate_message(message)
    verdict_input._validate_eval_hash(request.eval_hash)
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
