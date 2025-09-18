#!/usr/bin/env python3

import argparse
import base64
import logging
import os

from dotenv import load_dotenv

from .clickhouse_client_helper import CHCliFactory
from .github_client_helper import GHClientFactory
from .testers.autorevert_v2 import autorevert_v2
from .testers.hud import render_hud_html_from_clickhouse, write_hud_html
from .testers.restart_checker import workflow_restart_checker
from .utils import RestartAction, RevertAction


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

    # autorevert-checker subcommand
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
        type=RestartAction,
        default=RestartAction.RUN,
        choices=list(RestartAction),
        help=(
            "Restart mode: skip (no logging), log (no side effects), or run (dispatch)."
        ),
    )
    workflow_parser.add_argument(
        "--revert-action",
        type=RevertAction,
        default=RevertAction.LOG,
        choices=list(RevertAction),
        help=(
            "Revert mode: skip, log (no side effects), run-notify (side effect), or run-revert (side effect)."
        ),
    )
    workflow_parser.add_argument(
        "--hud-html",
        nargs="?",
        const="hud.html",
        default=None,
        help=(
            "If set, write the run state to HUD HTML at the given path (defaults to hud.html when flag provided)."
        ),
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
        "hud", help="Render HUD HTML from a logged autorevert run state"
    )
    hud_parser.add_argument(
        "timestamp",
        help="Run timestamp in UTC (e.g. '2025-09-17 20:29:15') matching misc.autorevert_state.ts",
    )
    hud_parser.add_argument(
        "--repo-full-name",
        dest="repo_full_name",
        default=None,
        help=(
            "Optional repo filter (owner/repo). Required if multiple runs share the same timestamp."
        ),
    )
    hud_parser.add_argument(
        "--hud-html",
        nargs="?",
        const="hud.html",
        default="hud.html",
        help="Output HTML file path (default: hud.html)",
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
            restart_action=(RestartAction.LOG if opts.dry_run else RestartAction.RUN),
            revert_action=RevertAction.LOG,
        )
    elif opts.subcommand == "autorevert-checker":
        # New default behavior under the same subcommand
        _signals, _pairs, state_json = autorevert_v2(
            opts.workflows,
            hours=opts.hours,
            repo_full_name=opts.repo_full_name,
            restart_action=(RestartAction.LOG if opts.dry_run else opts.restart_action),
            revert_action=(RevertAction.LOG if opts.dry_run else opts.revert_action),
        )
        if opts.hud_html:
            write_hud_html(state_json, opts.hud_html)
    elif opts.subcommand == "workflow-restart-checker":
        workflow_restart_checker(opts.workflow, commit=opts.commit, days=opts.days)
    elif opts.subcommand == "hud":
        # Delegate to testers.hud module
        render_hud_html_from_clickhouse(
            opts.timestamp,
            repo_full_name=opts.repo_full_name,
            out_path=opts.hud_html,
        )


if __name__ == "__main__":
    main()
