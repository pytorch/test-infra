#!/usr/bin/env python3

import argparse
import base64
import json
import logging
import os
import sys
from typing import Optional

import boto3
from dataclasses import dataclass
from dotenv import load_dotenv

from .autorevert_circuit_breaker import check_autorevert_disabled
from .clickhouse_client_helper import CHCliFactory
from .github_client_helper import GHClientFactory
from .testers.autorevert_v2 import autorevert_v2
from .testers.hud import render_hud_html_from_clickhouse, write_hud_html_from_cli
from .testers.restart_checker import workflow_restart_checker
from .utils import RestartAction, RevertAction


DEFAULT_WORKFLOWS = ["Lint", "trunk", "pull", "inductor"]
DEFAULT_REPO_FULL_NAME = "pytorch/pytorch"
DEFAULT_HOURS = 16
DEFAULT_COMMENT_ISSUE_NUMBER = (
    163650  # https://github.com/pytorch/pytorch/issues/163650
)
# Special constant to indicate --hud-html was passed as a flag (without a value)
HUD_HTML_NO_VALUE_FLAG = object()


def setup_logging(log_level: str) -> None:
    """Set up logging configuration."""
    numeric_level = getattr(logging, log_level.upper(), None)
    if not isinstance(numeric_level, int):
        raise ValueError(f"Invalid log level: {log_level}")

    root_logger = logging.getLogger()
    root_logger.setLevel(numeric_level)

    if not root_logger.handlers:
        handler = logging.StreamHandler()
        handler.setLevel(numeric_level)
        formatter = logging.Formatter(
            "%(asctime)s %(levelname)s [%(name)s] %(message)s"
        )
        handler.setFormatter(formatter)
        root_logger.addHandler(handler)
    else:
        for handler in root_logger.handlers:
            if handler.level == logging.NOTSET:
                handler.setLevel(numeric_level)


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
    parser.add_argument(
        "--secret-store-name",
        action="store",
        default=os.environ.get("SECRET_STORE_NAME", ""),
        help="Name of the secret in AWS Secrets Manager to fetch GitHub App secret from",
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
        "--hours",
        type=int,
        default=DEFAULT_HOURS,
        help=f"Lookback window in hours (default: {DEFAULT_HOURS})",
    )
    workflow_parser.add_argument(
        "--repo-full-name",
        default=os.environ.get("REPO_FULL_NAME", DEFAULT_REPO_FULL_NAME),
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
            "Revert mode: skip, log (no side effects), run-log (prod-style logging), run-notify, or run-revert."
        ),
    )
    workflow_parser.add_argument(
        "--hud-html",
        nargs="?",
        const=HUD_HTML_NO_VALUE_FLAG,
        default=None,
        help=(
            "If set, write the run state to HUD HTML; omit a value to use the run timestamp as the filename."
        ),
    )
    workflow_parser.add_argument(
        "--notify-issue-number",
        type=int,
        default=int(
            os.environ.get("NOTIFY_ISSUE_NUMBER", DEFAULT_COMMENT_ISSUE_NUMBER)
        ),
        help=f"Issue number to notify (default: {DEFAULT_COMMENT_ISSUE_NUMBER})",
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
        nargs="?",
        default=None,
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
        const=HUD_HTML_NO_VALUE_FLAG,
        default=None,
        help="Output HTML file path (defaults to the timestamp-based filename)",
    )

    return parser.parse_args()


@dataclass
class AWSSecretsFromStore:
    github_app_secret: str
    clickhouse_password: str


def get_secret_from_aws(secret_store_name: str) -> AWSSecretsFromStore:
    try:
        session = boto3.session.Session()
        client = session.client(service_name="secretsmanager", region_name="us-east-1")
        get_secret_value_response = client.get_secret_value(
            SecretId="pytorch-autorevert-secrets"
        )
        secret_value_string = json.loads(get_secret_value_response["SecretString"])
        return AWSSecretsFromStore(
            github_app_secret=base64.b64decode(
                secret_value_string["GITHUB_APP_SECRET"]
            ).decode("utf-8"),
            clickhouse_password=secret_value_string["CLICKHOUSE_PASSWORD"],
        )
    except Exception:
        logging.exception("Failed to retrieve secrets from AWS Secrets Manager")
        sys.exit(1)


def main(*args, **kwargs) -> None:
    load_dotenv()
    opts = get_opts()

    gh_app_secret = ""
    if opts.github_app_secret:
        gh_app_secret = base64.b64decode(opts.github_app_secret).decode("utf-8")

    ch_password = ""
    if ch_password:
        ch_password = opts.clickhouse_password

    if opts.secret_store_name:
        secrets = get_secret_from_aws(opts.secret_store_name)
        gh_app_secret = secrets.github_app_secret
        ch_password = secrets.clickhouse_password

    setup_logging(opts.log_level)
    CHCliFactory.setup_client(
        opts.clickhouse_host,
        opts.clickhouse_port,
        opts.clickhouse_username,
        ch_password,
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
        repo_name = os.environ.get("REPO_FULL_NAME", DEFAULT_REPO_FULL_NAME)

        if check_autorevert_disabled(repo_name):
            logging.error(
                "Autorevert is disabled via circuit breaker (ci: disable-autorevert issue found). "
                "Exiting successfully."
            )
            return

        autorevert_v2(
            os.environ.get("WORKFLOWS", ",".join(DEFAULT_WORKFLOWS)).split(","),
            hours=int(os.environ.get("HOURS", DEFAULT_HOURS)),
            notify_issue_number=int(
                os.environ.get("NOTIFY_ISSUE_NUMBER", DEFAULT_COMMENT_ISSUE_NUMBER)
            ),
            repo_full_name=repo_name,
            restart_action=(RestartAction.LOG if opts.dry_run else RestartAction.RUN),
            revert_action=(
                RevertAction.LOG if opts.dry_run else RevertAction.RUN_NOTIFY
            ),
        )
    elif opts.subcommand == "autorevert-checker":
        # New default behavior under the same subcommand
        _, _, state_json = autorevert_v2(
            opts.workflows,
            hours=opts.hours,
            notify_issue_number=opts.notify_issue_number,
            repo_full_name=opts.repo_full_name,
            restart_action=(RestartAction.LOG if opts.dry_run else opts.restart_action),
            revert_action=(RevertAction.LOG if opts.dry_run else opts.revert_action),
        )
        write_hud_html_from_cli(opts.hud_html, HUD_HTML_NO_VALUE_FLAG, state_json)
    elif opts.subcommand == "workflow-restart-checker":
        workflow_restart_checker(opts.workflow, commit=opts.commit, days=opts.days)
    elif opts.subcommand == "hud":
        out_path: Optional[str] = (
            None if opts.hud_html is HUD_HTML_NO_VALUE_FLAG else opts.hud_html
        )

        # Delegate to testers.hud module
        render_hud_html_from_clickhouse(
            opts.timestamp,
            repo_full_name=opts.repo_full_name,
            out_path=out_path,
        )


if __name__ == "__main__":
    main()
