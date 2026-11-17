"""Command-line entry point for the greenlight service."""

from __future__ import annotations

import argparse
import dataclasses
import functools
import logging
import os
import sys
from typing import TYPE_CHECKING

from greenlight import drci_poke, repo_config, repo_scan, verdict
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
from greenlight.snapshot_cache import SnapshotCache

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from github import Github

    from greenlight.scan_memory import ScanMemory
    from greenlight.tick import TokenSource

logger = logging.getLogger(__name__)

_ALL_REPOS_EXCLUDES = ("repo", "pr", "force", "requester", "allow_untrusted_author")

# Held at module level so they outlive main(): the Lambda handler calls main() once per tick, and a
# warm execution environment keeps this module loaded between ticks. The repos config is read every
# scan (ttl 0), serving its last good snapshot on any failure but a rate limit; each eligibility source
# is kept for merge_rules_ttl_seconds (repo_scan.eligibility_cache).
_SCAN_MEMORY: dict[str, ScanMemory] = {}
_CONFIG_CACHE: SnapshotCache[Github, repo_config.RepoConfig] = SnapshotCache(
    repo_config.fetch_config, ttl_seconds=0, max_stale_seconds=None, stale_on_broken=True
)
_ELIGIBILITY_CACHES: repo_scan.EligibilityCaches = {}


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
        help="scan one configured repo's open PRs from the evaluation cohort and dispatch the AI review workflow",
        description=(
            "Scan the open PRs from the evaluation cohort in --repo (every merge_rules.yaml "
            "approver, minus bots and greenlight itself), read each PR's latest recorded state, and "
            "dispatch the review workflow for new or changed PRs whose author is eligible under the "
            "merge rules: named by a valid rule, whatever files the PR changes, on a base trymerge "
            "accepts. Requires "
            "PYTORCH_GREENLIGHT_GITHUB_TOKEN and CLICKHOUSE_* read credentials. The repo must have an "
            "entry in greenlight/repos.yaml, read from pytorch/test-infra's default branch; its mode "
            "decides what the scan does (REPOS.md). PYTORCH_GREENLIGHT_DISPATCH_TOKEN, when set, reads "
            "that file and dispatches the review workflow instead."
        ),
    )
    review_parser.add_argument(
        "--repo", default=None, help=f"owner/name of the configured repo to scan (default {TARGET_REPO})"
    )
    review_parser.add_argument(
        "--all-repos",
        action="store_true",
        help=(
            "run one tick over every repo greenlight/repos.yaml serves: each repo's safety work, then its "
            "optional work under the tick's budgets, with --max shared between them (REPOS.md)"
        ),
    )
    review_parser.add_argument(
        "--pr",
        type=int,
        default=None,
        help=(
            "scan only this PR number (skips the listing; the PR's author must still be eligible for it "
            "under the merge rules)"
        ),
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
        help=(
            "login that requested this review (@greenlight recheck); must be in the evaluation cohort "
            "(a merge_rules.yaml approver, minus bots and greenlight itself), or the run refuses"
        ),
    )
    review_parser.add_argument(
        "--allow-untrusted-author",
        action="store_true",
        help=(
            "LOCAL USE ONLY: waive the eligibility requirement on the --pr target, reviewing it even "
            "when no valid merge rule names its author or trymerge refuses its base. Eligibility is still "
            "resolved and still decides shadow, so such a PR is reviewed in shadow and never approved "
            "(never exposed as a workflow input)"
        ),
    )

    verdict_parser = subparsers.add_parser(
        "verdict",
        help="record a PR review verdict once and act on GitHub",
        description=(
            "Record a single PR-review verdict: emit the row for S3 -> ClickHouse ingestion and, "
            "for LAND/NO_LAND, post the GitHub review. Runs once outside the daemon loop and lock. "
            "Requires PYTORCH_GREENLIGHT_GITHUB_TOKEN for LAND/NO_LAND, which, unless --shadow, also use "
            "it to check the merge rules (with their team members) and, when one names the author, the "
            "PR's head and base; "
            "if that check fails, the command fails without writing the row."
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
    verdict_parser.add_argument(
        "--shadow",
        action="store_true",
        help=(
            "record the verdict with no authority: never approve the PR, dismiss any prior greenlight "
            "approval, and keep the row out of Dr. CI and the land-time merge gate"
        ),
    )
    verdict_parser.add_argument("--log-level", default=None, help="logging level name")
    verdict_parser.add_argument(
        "--dry-run", action="store_true", help="log intended actions without writing or posting"
    )

    drci_parser = subparsers.add_parser(
        "drci-poke",
        help="ask Dr. CI to rebuild one pull request's comment",
        description=(
            "Poke the Dr. CI endpoint for a single pull request so its Dr. CI comment -- which "
            "renders greenlight's status on repositories that delegate it -- is rebuilt now instead "
            "of at the next scheduled sweep. Waits PYTORCH_GREENLIGHT_DRCI_POKE_DELAY_SECONDS first "
            "so the just-written state row has time to reach ClickHouse. Never fails: every error "
            "is logged and swallowed."
        ),
    )
    drci_parser.add_argument("--repo", default=TARGET_REPO, help="owner/name of the repository")
    drci_parser.add_argument("--pr", type=int, required=True, help="pull-request number")
    drci_parser.add_argument("--log-level", default=None, help="logging level name")
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


def _one_shot_config(args: argparse.Namespace, parser: argparse.ArgumentParser) -> Config:
    """Build and apply the config for a subcommand that runs once, outside the daemon loop."""
    try:
        config = Config.from_env()
        if args.log_level is not None:
            config = dataclasses.replace(config, log_level=args.log_level)
        configure_logging(config.log_level)
    except ValueError as exc:
        parser.error(str(exc))
    return config


def _run_drci_poke(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    config = _one_shot_config(args, parser)
    drci_poke.poke(args.repo, args.pr, config)
    return EXIT_OK


def _run_verdict(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    config = _one_shot_config(args, parser)
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
        shadow=args.shadow,
        dry_run=args.dry_run,
    )
    try:
        verdict.run(request, config)
    except Exception:
        logger.exception("greenlight verdict failed")
        return EXIT_FAILURE
    return EXIT_OK


def _all_repos_run(
    args: argparse.Namespace, config: Config, bot_login: str, tokens: TokenSource | None
) -> Callable[[Config], None]:
    from greenlight import tick  # lazy: keeps this module importable without PyGithub

    return functools.partial(
        tick.run_tick,
        tokens=tick.EnvTokens(config) if tokens is None else tokens,
        config_cache=_CONFIG_CACHE,
        eligibility_caches=_ELIGIBILITY_CACHES,
        memories=_SCAN_MEMORY,
        bot_login=bot_login,
        max_dispatches=args.max,
        ref=args.ref,
        timeout_minutes=args.timeout_minutes,
    )


def main(argv: Sequence[str] | None = None, *, tokens: TokenSource | None = None) -> int:
    """Run the CLI; ``tokens`` is the token source of ``review --all-repos`` (default: the environment's)."""
    parser = build_parser()
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == "verdict":
        return _run_verdict(args, parser)
    if args.command == "drci-poke":
        return _run_drci_poke(args, parser)
    try:
        config = _config_from_args(args)
        configure_logging(config.log_level)
    except ValueError as exc:
        parser.error(str(exc))
    lock_path = config.lock_path
    if lock_path is not None:
        logger.info("using single-instance lock path %s", lock_path)
    conflicts = [
        f"--{name.replace('_', '-')}"
        for name in _ALL_REPOS_EXCLUDES
        if (value := getattr(args, name)) is not None and value is not False
    ]
    if args.all_repos and conflicts:
        parser.error(f"--all-repos cannot be combined with {', '.join(conflicts)}")
    if args.force and args.pr is None:
        parser.error("--force requires --pr")
    if args.force and args.loop:
        parser.error("--force cannot be combined with --loop")
    # The bot login is the App's <slug>[bot] account, supplied via BOT_LOGIN. It author-scopes the
    # recheck-refusal comment and identifies greenlight's own approvals for both dismissals, on a
    # reverted PR and on a PR no longer eligible; when set it must be App-shaped, or a copied marker in
    # a third party's comment could be hijacked. An empty value parses (each dismissal refuses it when
    # it has something to dismiss).
    bot_login = os.environ.get("BOT_LOGIN", "").strip()
    if bot_login and not is_app_login(bot_login):
        parser.error(
            f"BOT_LOGIN must be a GitHub App login of the form <app-slug>{BOT_LOGIN_SUFFIX}, got {bot_login!r}"
        )
    if args.all_repos:
        return _dispatch(config, _all_repos_run(args, config, bot_login, tokens), loop=args.loop, lock_path=lock_path)
    run = functools.partial(
        repo_scan.scan_repo,
        repo=TARGET_REPO if args.repo is None else args.repo,
        config_cache=_CONFIG_CACHE,
        eligibility_caches=_ELIGIBILITY_CACHES,
        memories=None if args.pr is not None else _SCAN_MEMORY,
        pr=args.pr,
        max_dispatches=args.max,
        ref=args.ref,
        timeout_minutes=args.timeout_minutes,
        force=args.force,
        requester=args.requester,
        allow_untrusted_author=args.allow_untrusted_author,
        bot_login=bot_login,
    )
    return _dispatch(config, run, loop=args.loop, lock_path=lock_path)
