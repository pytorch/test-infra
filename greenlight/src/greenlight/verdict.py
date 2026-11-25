"""One-shot recording of a PR review verdict, invoked by a privileged CI job.

Unlike the ``review`` phase this is a single action, not a daemon iteration: it runs
outside the loop, lock, and watchdog machinery and raises on any failure so the CLI
maps it straight to an exit code.

Statuses split into two modes. FULL verdicts (LAND / NO_LAND) carry a ``--verdict-file`` holding
``{status, reason, message}``; ``reason`` must be one of ``ALLOWED_REASONS`` -- and exactly
``constants.LAND_REASON`` when the status is LAND -- while ``message`` must be non-empty. The
command emits a gzipped single-line JSONEachRow row to a fixed local path (the record workflow
uploads it to ``s3://gha-artifacts/``, where the clickhouse-replicator-s3 path ingests it into
``misc.greenlight_pr_state``) and then updates GitHub with a defanged copy of the message. Both LAND
and NO_LAND upsert one canonical verdict comment -- edited in place across runs, found by a hidden
marker and restricted to greenlight's own account (``bot_login``); a LAND that is not shadow
additionally approves the PR through ``land_approval`` (pinned to the reviewed head, left as it is when
greenlight's counted review and every live approval already stand there, withdrawn when a re-read finds the
PR moved), and
NO_LAND additionally dismisses greenlight's own prior approval (both matched by ``bot_login``).
A LAND or NO_LAND is shadow when ``--shadow`` is passed, the repo's settings read from its own
``.github/greenlight/config.yml`` on its default branch (``repo_config``) are safety-only or not
``active``, on a ``gate`` repo a LAND that ``land_approval.gate_backs`` refuses (a ``bot_login`` other than
``approvals.GREENLIGHT_LOGIN``, the account the merge gate and the scan judge, or branch rules that do not
enforce the gate), or when ``author_eligibility.has_eligible_author`` finds that the entry's eligibility
source (a valid merge rule, or write permission) does not qualify its author, or finds the PR off the
reviewed head or on a base the entry's safety refuses;
a failed check fails the command before the row is written, after a NO_LAND, or a LAND passed
``--shadow``, has already dismissed. A
shadow verdict carries no authority, and that is absolute rather than forward-looking: no approving
review is ever posted for one, any prior greenlight approval is dismissed on the LAND path as well
as the NO_LAND one, before the row is emitted, so a failed emit never leaves that approval standing,
and the row is stamped ``shadow`` so neither Dr. CI nor the merge gate reads it.
Withholding a new approval would not take back one collected while the PR was eligible, and a live
approval is authority whatever the row says. The row is authoritative, so the comment upsert is
best-effort on every path (a failed write is logged and swallowed); the LAND approving review and
the NO_LAND dismissal are the merge gate and stay load-bearing -- they raise on failure. An
authoritative LAND or NO_LAND also makes that verdict's ``GL/*`` label the PR's only one
(``verdict_labels``), best-effort too, unless the PR is closed, has moved off the reviewed head or
carries ``Reverted``. MARKER statuses (CANCELLED / FAILED / AI_REVIEW_STARTED) always emit the row
and, when a ``bot_login`` and token are both present, best-effort upsert that same canonical comment
to show the run as in-progress (AI_REVIEW_STARTED) or not-completed (CANCELLED / FAILED). The
command never writes to ClickHouse directly.

A LAND or NO_LAND on a repo with no valid settings, or whose file cannot be read, fails the command
with no row (a NO_LAND, or a LAND passed ``--shadow``, still dismisses first); a marker never fails on
that read (``repo_config.marker_entry``).
Every comment upsert above is skipped for a shadow row or marker, and on the repos whose entry's
``status_comment`` is ``drci``, where Dr. CI renders the same state from the emitted row and the
``drci-poke`` command refreshes that render instead. Everywhere else greenlight posts the comment
itself, so no PR is left with a recorded verdict and no visible status. The row emit, the LAND
approving review, and the NO_LAND dismissal are unaffected on every repo.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from greenlight import (
    comment_format,
    constants,
    github_client,
    land_approval,
    redact,
    repo_config,
    state_emit,
    verdict_input,
    verdict_labels,
)
from greenlight.author_eligibility import has_eligible_author
from greenlight.constants import ALLOWED_REASONS, STATUS_LAND, STATUS_NO_LAND, TERMINAL_STATUSES, VERDICT_STATUSES

if TYPE_CHECKING:
    from collections.abc import Callable

    from greenlight.config import Config
    from greenlight.github_types import VerdictClient, VerdictPR
    from greenlight.repo_config import RepoEntry


__all__ = ["ALLOWED_REASONS", "VERDICT_STATUSES", "VerdictRequest", "run"]

logger = logging.getLogger(__name__)

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


def _authoritative(request: VerdictRequest, entry: RepoEntry, served: bool) -> bool:
    return not request.shadow and served and entry.mode == "active"


def _best_effort_upsert(
    request: VerdictRequest,
    config: Config,
    body: str,
    *,
    entry: RepoEntry,
    shadow: bool,
    build_github: Callable[[str], VerdictClient],
    pr: VerdictPR | None = None,
) -> None:
    """Upsert the canonical verdict comment as a best-effort, cosmetic write.

    Skipped for a ``shadow`` row or marker, and on a repo whose entry's ``status_comment`` is
    ``drci``, because Dr. CI shows the same state from the emitted row and the ``drci-poke`` command
    refreshes that render instead.

    The emitted row is authoritative; the comment is cosmetic. A raise here would fail the CLI
    and skip the workflow's ``success()``-gated S3 upload, losing the row -- so any failure is
    logged and swallowed. ``pr`` is reused when the caller already fetched it for a load-bearing
    action (the LAND review / NO_LAND dismiss); otherwise the client and PR are fetched here so a
    transient fetch failure is swallowed too.
    """
    if entry.status_comment == "drci":
        logger.info("Dr. CI renders the status comment on %s; skipping upsert", request.repo)
        return
    if shadow:
        logger.info("shadow row on %s#%d; skipping the status comment", request.repo, request.pr_number)
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
    # Markers take request.shadow and the repo's settings, which never fail closed, and never look the
    # author up. Both jobs that reach here mint the App token with continue-on-error, so a lookup can fail,
    # and fail-closed derivation would hide a trusted author's in-flight marker from the merge gate -- a
    # WAIT, then a DENY.
    entry, served = repo_config.marker_entry(config.github_token, request.repo)
    shadow = not _authoritative(request, entry, served)
    key = _emit_payload(request, status, "", "", shadow=shadow, now=now, emit=emit, new_emit_id=new_emit_id)
    logger.info("emitted %s marker payload for %s#%d -> %s", status, request.repo, request.pr_number, key)
    if not request.bot_login:
        return
    body = comment_format.marker_body(status, request.agent_job_url or request.eval_job_url, request.run_id)
    _best_effort_upsert(request, config, body, entry=entry, shadow=shadow, build_github=build_github)


def _dismiss_prior_approvals(request: VerdictRequest, pr: VerdictPR) -> None:
    land_approval.dismiss_prior(pr, repo=request.repo, number=request.pr_number, bot_login=request.bot_login)


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
    author, author_type = (pr.user.login, pr.user.type) if pr.user is not None else (None, None)
    # A NO_LAND, and a LAND the request already marks shadow, dismiss whatever the lookups below
    # answer, so they go first: a lookup that fails must not leave greenlight's approval standing on a
    # PR the review just rejected or that carries no authority.
    dismissed = status == STATUS_NO_LAND or request.shadow
    if dismissed:
        _dismiss_prior_approvals(request, pr)
    entry, served = repo_config.record_entry(token, request.repo)
    # OR, never AND: the caller's value and this one are derived independently, so a disagreement
    # means the approval was withheld. Stamping the row non-shadow anyway would render a LAND in
    # Dr. CI and offer the merge gate an authorization that no review backs. The short circuit also
    # keeps a shadow request, or a repo not served and active, from resolving eligibility at all. The
    # lookup is handed the reviewed head, not the live one. A gate repo's login and rules are checked before
    # it, so nothing slow sits between the lookup's PR read and the approval.
    shadow = (
        not _authoritative(request, entry, served)
        or (
            status == STATUS_LAND
            and entry.strict_base
            and not land_approval.gate_backs(token, request.repo, bot_login=request.bot_login)
        )
        or not has_eligible_author(
            token,
            request.repo,
            request.pr_number,
            request.head_sha,
            author,
            eligibility=entry.eligibility,
            minimum_role=entry.minimum_role,
            author_type=author_type,
            strict_base=entry.strict_base,
        )
    )
    if status == STATUS_LAND and shadow and not dismissed:
        # A shadow PR must never carry a live greenlight approval. Under merge_rules.yaml's
        # wildcard Greenlight Review Bot rule one approval authorizes a merge of any path in
        # the repo, so an approval collected while the PR was eligible is still authority --
        # withholding a new one does not take the old one back. Before the emit, so a failed
        # emit cannot leave it standing.
        _dismiss_prior_approvals(request, pr)
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
        else:
            land_approval.approve(
                client,
                pr,
                repo=request.repo,
                number=request.pr_number,
                head_sha=request.head_sha,
                bot_login=request.bot_login,
                strict_base=entry.strict_base,
            )
    if not shadow:
        verdict_labels.label_verdict(pr, status, reviewed_head=request.head_sha, number=request.pr_number)
    _best_effort_upsert(request, config, body, entry=entry, shadow=shadow, build_github=build_github, pr=pr)


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
