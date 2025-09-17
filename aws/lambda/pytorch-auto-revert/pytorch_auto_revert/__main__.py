#!/usr/bin/env python3

import argparse
import base64
import logging
import os

from dotenv import load_dotenv

from .clickhouse_client_helper import CHCliFactory
from .github_client_helper import GHClientFactory
from .testers.autorevert_v2 import autorevert_v2
from .testers.hud import run_hud
from .testers.restart_checker import workflow_restart_checker
from .utils import RestartRevertAction


DEFAULT_WORKFLOWS = ["Lint", "trunk", "pull", "inductor"]


def setup_logging(log_level: str) -> None:
    """Set up logging configuration."""
    numeric_level = getattr(logging, log_level.upper(), None)
    if not isinstance(numeric_level, int):
        raise ValueError(f"Invalid log level: {log_level}")
    logging.basicConfig(level=numeric_level)


def get_opts() -> argparse.Namespace:
    parser = argparse.ArgumentParser()

    # General options and configurations
    parser.add_argument(
        "--log-level",
        default=os.environ.get("LOG_LEVEL", "INFO"),
        choices=["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        help="Set the logging level for the application.",
    )
    parser.add_argument(
        "--clickhouse-host", default=os.environ.get("CLICKHOUSE_HOST", "")
    )
    parser.add_argument(
        "--clickhouse-port",
        type=int,
        default=int(os.environ.get("CLICKHOUSE_PORT", "8443")),
    )
    parser.add_argument(
        "--clickhouse-username", default=os.environ.get("CLICKHOUSE_USERNAME", "")
    )
    parser.add_argument(
        "--clickhouse-password", default=os.environ.get("CLICKHOUSE_PASSWORD", "")
    )
    parser.add_argument(
        "--clickhouse-database",
        default=os.environ.get("CLICKHOUSE_DATABASE", "default"),
    )
    parser.add_argument(
        "--github-access-token", default=os.environ.get("GITHUB_TOKEN", "")
    )
    parser.add_argument("--github-app-id", default=os.environ.get("GITHUB_APP_ID", ""))
    parser.add_argument(
        "--github-app-secret", default=os.environ.get("GITHUB_APP_SECRET", "")
    )
    parser.add_argument(
        "--github-installation-id",
        type=int,
        default=int(os.environ.get("GITHUB_INSTALLATION_ID", "0")),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be restarted without actually doing it",
    )

    # no subcommand runs the lambda flow
    subparsers = parser.add_subparsers(dest="subcommand")

    # autorevert-checker subcommand (new default; legacy behind a flag)
    workflow_parser = subparsers.add_parser(
        "autorevert-checker",
        help="Analyze workflows for autorevert using Signals (default), or legacy via flag",
    )
    workflow_parser.add_argument(
        "workflows",
        nargs="+",
        default=DEFAULT_WORKFLOWS,
        help="Workflow name(s) to analyze - single name or comma/space separated"
        + ' list (e.g., "pull" or "pull,trunk,inductor")',
    )
    workflow_parser.add_argument(
        "--hours", type=int, default=48, help="Lookback window in hours (default: 48)"
    )
    workflow_parser.add_argument(
        "--repo-full-name",
        default=os.environ.get("REPO_FULL_NAME", "pytorch/pytorch"),
        help="Full repo name to filter by (owner/repo).",
    )
    workflow_parser.add_argument(
        "--restart-action",
        type=RestartRevertAction,
        default=RestartRevertAction.Run,
        choices=list(RestartRevertAction),
        help="What actions to take for restart: Ignore (bypass), run in dry-run mode, or run normally.",
    )
    workflow_parser.add_argument(
        "--revert-action",
        type=RestartRevertAction,
        default=RestartRevertAction.Run,
        choices=list(RestartRevertAction),
        help="What actions to take for revert: Ignore (bypass), run in dry-run mode, or run normally.",
    )

    # workflow-restart-checker subcommand
    workflow_restart_parser = subparsers.add_parser(
        "workflow-restart-checker", help="Check for restarted workflows"
    )
    workflow_restart_parser.add_argument(
        "workflow",
        help="Workflow file name (e.g., trunk.yml)",
    )
    workflow_restart_parser.add_argument(
        "--commit",
        help="Check specific commit SHA",
    )
    workflow_restart_parser.add_argument(
        "--days",
        type=int,
        default=7,
        help="If no `--commit` specified, look back days for bulk query (default: 7)",
    )

    # hud subcommand: generate local HTML report for signals/detections
    hud_parser = subparsers.add_parser(
        "hud", help="Generate local HUD-like HTML with extracted signals"
    )
    hud_parser.add_argument(
        "workflows",
        nargs="+",
        help="Workflow name(s) to analyze - e.g. trunk pull inductor",
    )
    hud_parser.add_argument(
        "--hours", type=int, default=24, help="Lookback window in hours (default: 24)"
    )
    hud_parser.add_argument(
        "--repo-full-name",
        default=os.environ.get("REPO_FULL_NAME", "pytorch/pytorch"),
        help="Full repo name to filter by (owner/repo).",
    )
    hud_parser.add_argument(
        "--out",
        default="hud.html",
        help="Output HTML file path (default: hud.html)",
    )
    hud_parser.add_argument(
        "--ignore-newer-than",
        dest="ignore_newer_than",
        default=None,
        help=(
            "Commit SHA (short or long) — drop all commits that are newer than "
            "this SHA from signal detection and HUD rendering"
        ),
    )

    return parser.parse_args()


def main(*args, **kwargs) -> None:
    load_dotenv()
    opts = get_opts()

    gh_app_secret = ""
    if opts.github_app_secret:
        gh_app_secret = base64.b64decode(opts.github_app_secret).decode("utf-8")

    setup_logging(opts.log_level)
    CHCliFactory.setup_client(
        opts.clickhouse_host,
        opts.clickhouse_port,
        opts.clickhouse_username,
        opts.clickhouse_password,
        opts.clickhouse_database,
    )
    GHClientFactory.setup_client(
        opts.github_app_id,
        gh_app_secret,
        opts.github_installation_id,
        opts.github_access_token,
    )

    if not CHCliFactory().connection_test():
        raise RuntimeError(
            "ClickHouse connection test failed. Please check your configuration."
        )

    if opts.subcommand is None:
        # New default without subcommand: run v2 using env defaults
        autorevert_v2(
            os.environ.get("WORKFLOWS", "Lint,trunk,pull,inductor").split(","),
            hours=int(os.environ.get("HOURS", 16)),
            repo_full_name=os.environ.get("REPO_FULL_NAME", "pytorch/pytorch"),
            dry_run=opts.dry_run,
            restart_action=RestartRevertAction.RUN,
            revert_action=RestartRevertAction.DRY_RUN,
        )
    elif opts.subcommand == "autorevert-checker":
        # New default behavior under the same subcommand
        autorevert_v2(
            opts.workflows,
            hours=opts.hours,
            repo_full_name=opts.repo_full_name,
            restart_action=RestartRevertAction.RUN
            if opts.dry_run
            else opts.restart_action,
            revert_action=RestartRevertAction.DRY_RUN
            if opts.dry_run
            else opts.revert_action,
        )
    elif opts.subcommand == "workflow-restart-checker":
        workflow_restart_checker(opts.workflow, commit=opts.commit, days=opts.days)
    elif opts.subcommand == "hud":
        # Delegate to testers.hud module
        run_hud(
            opts.workflows,
            hours=opts.hours,
            repo_full_name=opts.repo_full_name,
            out=opts.out,
            ignore_newer_than=getattr(opts, "ignore_newer_than", None),
        )


if __name__ == "__main__":
    main()
