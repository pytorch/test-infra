"""Command-line entry point for the greenlight service."""

from __future__ import annotations

import argparse
import dataclasses
import functools
import logging
import os
import sys
from typing import TYPE_CHECKING

from greenlight import github_client, merge_authz, review, verdict
from greenlight.config import Config
from greenlight.constants import (
    BOT_LOGIN_SUFFIX,
    DEFAULT_DISPATCH_REF,
    DEFAULT_TIMEOUT_MINUTES,
    TARGET_REPO,
    is_app_login,
)
from greenlight.exit_codes import EXIT_ALREADY_RUNNING, EXIT_FAILURE, EXIT_OK
from greenlight.guards import LockError, SingleInstanceError, single_instance_lock
from greenlight.log import configure_logging
from greenlight.runner import execute_once, run_forever

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

logger = logging.getLogger(__name__)


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--loop", action="store_true", help="run continuously as a daemon")
    common.add_argument("--interval", type=float, default=None, help="seconds between iterations")
    common.add_argument("--log-level", default=None, help="logging level name")
    common.add_argument("--lock-path", default=None, help="single-instance lock file path")

    parser = argparse.ArgumentParser(
        prog="greenlight",
        description="Run a greenlight phase once (default) or as a resilient daemon with --loop.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    review_parser = subparsers.add_parser(
        "review",
        parents=[common],
        help="scan open PRs from trusted authors in pytorch/pytorch and dispatch the AI review workflow",
        description=(
            "Scan the open PRs from a fixed set of trusted authors in pytorch/pytorch, read each PR's "
            "latest recorded state, and dispatch the review workflow for new or changed PRs. "
            "Requires PYTORCH_GREENLIGHT_GITHUB_TOKEN and CLICKHOUSE_* read credentials."
        ),
    )
    review_parser.add_argument(
        "--pr",
        type=int,
        default=None,
        help="scan only this PR number (skips the listing; the PR's author must still be trusted)",
    )
    review_parser.add_argument(
        "--max",
        type=int,
        default=None,
        help="cap the number of workflow dispatches per scan; skipped and waiting PRs do not count",
    )
    review_parser.add_argument("--ref", default=DEFAULT_DISPATCH_REF, help="git ref of the review workflow to dispatch")
    review_parser.add_argument(
        "--timeout-minutes",
        type=int,
        default=DEFAULT_TIMEOUT_MINUTES,
        help="minutes before an in-flight or failed review is re-dispatched",
    )
    review_parser.add_argument(
        "--force",
        action="store_true",
        help="re-dispatch even if already reviewed; requires --pr, not allowed with --loop",
    )
    review_parser.add_argument(
        "--requester",
        default=None,
        help="login that requested this review (@greenlight recheck); must be a trusted author or the run refuses",
    )
    review_parser.add_argument(
        "--allow-untrusted-author",
        action="store_true",
        help="LOCAL USE ONLY: skip the --pr target-author trusted check (never exposed as a workflow input)",
    )

    verdict_parser = subparsers.add_parser(
        "verdict",
        help="record a PR review verdict once and act on GitHub",
        description=(
            "Record a single PR-review verdict: emit the row for S3 -> ClickHouse ingestion and, "
            "for LAND/NO_LAND, post the GitHub review. Runs once outside the daemon loop and lock. "
            "Requires PYTORCH_GREENLIGHT_GITHUB_TOKEN for LAND/NO_LAND."
        ),
    )
    verdict_parser.add_argument("--repo", default=TARGET_REPO, help="owner/name of the repository")
    verdict_parser.add_argument("--pr", type=int, required=True, help="pull-request number")
    verdict_parser.add_argument("--head-sha", required=True, help="expected PR head SHA at evaluation time")
    verdict_parser.add_argument("--eval-hash", default="", help="land-guard fingerprint to store verbatim")
    verdict_parser.add_argument(
        "--status",
        choices=sorted(verdict.VERDICT_STATUSES),
        default=None,
        help="verdict status; if omitted it is read from --verdict-file",
    )
    verdict_parser.add_argument("--verdict-file", default=None, help="JSON file with {status, reason, message}")
    verdict_parser.add_argument("--agent-job-url", default="", help="URL of the agent job that produced the verdict")
    verdict_parser.add_argument("--eval-job-url", default="", help="URL of the evaluation job")
    verdict_parser.add_argument(
        "--bot-login",
        default="",
        help="greenlight bot login (e.g. greenlight-app[bot]); required to dismiss prior approvals on NO_LAND",
    )
    verdict_parser.add_argument(
        "--run-id",
        type=int,
        default=None,
        help="CI run id that owns the status comment; an older run never overwrites a newer run's comment",
    )
    verdict_parser.add_argument("--log-level", default=None, help="logging level name")
    verdict_parser.add_argument(
        "--dry-run", action="store_true", help="log intended actions without writing or posting"
    )
    return parser


def _config_from_args(args: argparse.Namespace) -> Config:
    config = Config.from_env()
    if args.interval is not None:
        config = dataclasses.replace(config, interval_seconds=args.interval)
    if args.log_level is not None:
        config = dataclasses.replace(config, log_level=args.log_level)
    if args.lock_path is not None:
        config = dataclasses.replace(config, lock_path=args.lock_path)
    return config


def _build_authz_client(config: Config) -> merge_authz.AuthzClient:
    token = config.github_token
    if token is None:
        raise ValueError("PYTORCH_GREENLIGHT_GITHUB_TOKEN is required to resolve merge authorization")
    return github_client.build_client(token)


def _dispatch(config: Config, run: Callable[[Config], None], *, loop: bool, lock_path: str | None) -> int:
    try:
        with single_instance_lock(lock_path):
            if loop:
                run_forever(config, run=run)
            else:
                execute_once(config, run)
    except SingleInstanceError:
        logger.error("another greenlight instance is running; skipping")
        return EXIT_ALREADY_RUNNING
    except LockError:
        logger.exception("cannot acquire single-instance lock at %s", lock_path)
        return EXIT_FAILURE
    except Exception:
        logger.exception("greenlight phase failed")
        return EXIT_FAILURE
    return EXIT_OK


def _run_verdict(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    try:
        config = Config.from_env()
        if args.log_level is not None:
            config = dataclasses.replace(config, log_level=args.log_level)
        configure_logging(config.log_level)
    except ValueError as exc:
        parser.error(str(exc))
    request = verdict.VerdictRequest(
        repo=args.repo,
        pr_number=args.pr,
        head_sha=args.head_sha,
        eval_hash=args.eval_hash,
        status=args.status,
        verdict_file=args.verdict_file,
        agent_job_url=args.agent_job_url,
        eval_job_url=args.eval_job_url,
        bot_login=args.bot_login,
        run_id=args.run_id,
        dry_run=args.dry_run,
    )
    try:
        verdict.run(request, config)
    except Exception:
        logger.exception("greenlight verdict failed")
        return EXIT_FAILURE
    return EXIT_OK


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == "verdict":
        return _run_verdict(args, parser)
    try:
        config = _config_from_args(args)
        configure_logging(config.log_level)
    except ValueError as exc:
        parser.error(str(exc))
    lock_path = config.lock_path
    if lock_path is not None:
        logger.info("using single-instance lock path %s", lock_path)
    if args.force and args.pr is None:
        parser.error("--force requires --pr")
    if args.force and args.loop:
        parser.error("--force cannot be combined with --loop")
    # The bot login is the App's <slug>[bot] account, supplied via BOT_LOGIN (empty on the
    # read-only listing scan, set only on the write-capable --pr recheck). It author-scopes the
    # recheck-refusal comment; when set it must be App-shaped, or a copied marker in a third
    # party's comment could be hijacked. An empty value is allowed and handled downstream.
    bot_login = os.environ.get("BOT_LOGIN", "").strip()
    if bot_login and not is_app_login(bot_login):
        parser.error(
            f"BOT_LOGIN must be a GitHub App login of the form <app-slug>{BOT_LOGIN_SUFFIX}, got {bot_login!r}"
        )
    # One cache for the whole process: bound into the partial here (not per iteration), so a
    # --loop daemon refetches merge_rules at most once per TTL across all its scans.
    authorized_cache = merge_authz.AuthorizedLoginsCache(
        build_client=lambda: _build_authz_client(config),
        ttl_seconds=config.merge_rules_ttl_seconds,
    )
    run = functools.partial(
        review.run,
        pr=args.pr,
        max_dispatches=args.max,
        ref=args.ref,
        timeout_minutes=args.timeout_minutes,
        force=args.force,
        requester=args.requester,
        allow_untrusted_author=args.allow_untrusted_author,
        bot_login=bot_login,
        resolve_authorized=authorized_cache.get,
    )
    return _dispatch(config, run, loop=args.loop, lock_path=lock_path)
