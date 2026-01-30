#!/usr/bin/env python3

import argparse
import base64
import json
import logging
import os
import sys
from dataclasses import dataclass
from typing import Optional

import boto3
from dotenv import load_dotenv

from .autorevert_circuit_breaker import check_autorevert_disabled
from .clickhouse_client_helper import CHCliFactory
from .config import (
    AutorevertConfig,
    DEFAULT_CIRCUIT_BREAKER_APPROVED_USERS,
    DEFAULT_CLICKHOUSE_DATABASE,
    DEFAULT_CLICKHOUSE_HOST,
    DEFAULT_CLICKHOUSE_PORT,
    DEFAULT_HOURS,
    DEFAULT_LOG_LEVEL,
    DEFAULT_NOTIFY_ISSUE_NUMBER,
    DEFAULT_REPO_FULL_NAME,
    DEFAULT_WORKFLOW_RESTART_DAYS,
    DEFAULT_WORKFLOWS,
)
from .github_client_helper import GHClientFactory
from .testers.autorevert_v2 import autorevert_v2
from .testers.hud import render_hud_html_from_clickhouse, write_hud_html_from_cli
from .testers.restart_checker import dispatch_workflow_restart, workflow_restart_checker
from .utils import parse_datetime, RestartAction, RetryWithBackoff, RevertAction


# Special constant to indicate --hud-html was passed as a flag (without a value)
HUD_HTML_NO_VALUE_FLAG = object()


class DefaultConfig:
    """Configuration loaded from environment variables.

    This class reads configuration values from environment variables at instantiation
    time, providing defaults for the pytorch-auto-revert system. It serves as the
    base configuration that can be overridden by CLI arguments or EventBridge events.

    Attributes:
        bisection_limit: Max new pending jobs to schedule per signal (from BISECTION_LIMIT).
        clickhouse_database: ClickHouse database name (from CLICKHOUSE_DATABASE).
        clickhouse_host: ClickHouse server hostname (from CLICKHOUSE_HOST).
        clickhouse_password: ClickHouse password (from CLICKHOUSE_PASSWORD).
        clickhouse_port: ClickHouse server port (from CLICKHOUSE_PORT).
        clickhouse_username: ClickHouse username (from CLICKHOUSE_USERNAME).
        github_access_token: GitHub personal access token (from GITHUB_TOKEN).
        github_app_id: GitHub App ID for authentication (from GITHUB_APP_ID).
        github_app_secret: GitHub App secret, base64 encoded (from GITHUB_APP_SECRET).
        github_installation_id: GitHub App installation ID (from GITHUB_INSTALLATION_ID).
        hours: Lookback window in hours (from HOURS).
        log_level: Logging level (from LOG_LEVEL).
        notify_issue_number: GitHub issue number for notifications (from NOTIFY_ISSUE_NUMBER).
        repo_full_name: Repository in owner/repo format (from REPO_FULL_NAME).
        restart_action: Action to take for restarts (from RESTART_ACTION).
        revert_action: Action to take for reverts (from REVERT_ACTION).
        secret_store_name: AWS Secrets Manager secret name (from SECRET_STORE_NAME).
        workflows: List of workflow names to analyze (from WORKFLOWS).
    """

    def __init__(self) -> None:
        """Initialize configuration from environment variables."""
        self.bisection_limit = (
            int(os.environ["BISECTION_LIMIT"])
            if "BISECTION_LIMIT" in os.environ
            else None
        )
        self.clickhouse_database = os.environ.get("CLICKHOUSE_DATABASE", "default")
        self.clickhouse_host = os.environ.get("CLICKHOUSE_HOST", "localhost")
        self.clickhouse_password = os.environ.get("CLICKHOUSE_PASSWORD", "")
        self.clickhouse_port = int(os.environ.get("CLICKHOUSE_PORT", 8443))
        self.clickhouse_username = os.environ.get("CLICKHOUSE_USERNAME", "")
        self.github_access_token = os.environ.get("GITHUB_TOKEN", "")
        self.github_app_id = os.environ.get("GITHUB_APP_ID", "")
        self.github_app_secret = os.environ.get("GITHUB_APP_SECRET", "")
        self.github_installation_id = int(os.environ.get("GITHUB_INSTALLATION_ID", ""))
        self.hours = int(os.environ.get("HOURS", 16))
        self.log_level = os.environ.get("LOG_LEVEL", "INFO")
        self.notify_issue_number = int(
            os.environ.get("NOTIFY_ISSUE_NUMBER", 163650)
        )  # https://github.com/pytorch/pytorch/issues/163650
        self.repo_full_name = os.environ.get("REPO_FULL_NAME", "pytorch/pytorch")
        self.restart_action = (
            RestartAction.from_str(os.environ["RESTART_ACTION"])
            if "RESTART_ACTION" in os.environ
            else None
        )
        self.revert_action = (
            RevertAction.from_str(os.environ["REVERT_ACTION"])
            if "REVERT_ACTION" in os.environ
            else None
        )
        self.secret_store_name = os.environ.get("SECRET_STORE_NAME", "")
        self.workflows = os.environ.get(
            "WORKFLOWS",
            ",".join(["Lint", "trunk", "pull", "inductor", "linux-aarch64", "slow"]),
        ).split(",")
        # Circuit breaker approved users (comma-separated GitHub usernames)
        approved_users_str = os.environ.get("CIRCUIT_BREAKER_APPROVED_USERS", "")
        self.circuit_breaker_approved_users = (
            set(approved_users_str.split(",")) if approved_users_str else set()
        )

    def to_autorevert_v2_params(
        self,
        *,
        default_restart_action: RestartAction,
        default_revert_action: RevertAction,
        dry_run: bool,
    ) -> dict:
        """Convert the configuration to parameters for autorevert_v2.

        Args:
            default_restart_action: Default restart action if none specified in config.
            default_revert_action: Default revert action if none specified in config.
            dry_run: If True, override actions to LOG mode (no side effects).

        Returns:
            Dictionary of keyword arguments for autorevert_v2 function.
        """
        return {
            "workflows": self.workflows,
            "repo_full_name": self.repo_full_name,
            "hours": self.hours,
            "notify_issue_number": self.notify_issue_number,
            "restart_action": RestartAction.LOG
            if dry_run
            else (self.restart_action or default_restart_action),
            "revert_action": RevertAction.LOG
            if dry_run
            else (self.revert_action or default_revert_action),
            "bisection_limit": self.bisection_limit,
        }


def validate_actions_dry_run(
    config: AutorevertConfig, env_has_explicit_actions: bool
) -> None:
    """Validate the actions to be taken in dry run mode.

    Args:
        config: The AutorevertConfig instance with all configuration values.
        env_has_explicit_actions: Whether explicit actions were set via environment variables.
    """
    if env_has_explicit_actions and config.dry_run:
        logging.error(
            "Dry run mode: using dry-run flag with environment variables is not allowed."
        )
        raise ValueError(
            "Conflicting options: --dry-run with explicit actions via environment variables"
        )
    if (
        config.subcommand == "autorevert-checker"
        and (config.restart_action is not None or config.revert_action is not None)
        and config.dry_run
    ):
        logging.error(
            "Dry run mode: using dry-run flag with explicit actions is not allowed."
        )
        raise ValueError("Conflicting options: --dry-run with explicit actions")


def setup_logging(log_level: str) -> None:
    """Configure the root logger with the specified log level.

    Sets up a StreamHandler with a standard format if no handlers exist,
    or updates existing handlers that have NOTSET level.

    Args:
        log_level: Logging level as a string (e.g., "DEBUG", "INFO", "WARNING").

    Raises:
        ValueError: If the log level string is not a valid logging level.
    """
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


def get_opts(default_config: DefaultConfig) -> argparse.Namespace:
    """Parse command-line arguments for the pytorch-auto-revert CLI.

    Configures an argument parser with:
    - Global options (logging, ClickHouse, GitHub, secrets)
    - Subcommands: autorevert-checker, workflow-restart-checker, hud

    Default values for all arguments are taken from the provided DefaultConfig,
    allowing environment variables to set defaults that CLI args can override.

    Args:
        default_config: Configuration with default values from environment variables.

    Returns:
        Parsed arguments as an argparse.Namespace object.
    """
    parser = argparse.ArgumentParser()

    # General options and configurations
    parser.add_argument(
        "--log-level",
        default=default_config.log_level,
        choices=["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        help="Set the logging level for the application.",
    )
    parser.add_argument("--clickhouse-host", default=default_config.clickhouse_host)
    parser.add_argument(
        "--clickhouse-port",
        type=int,
        default=default_config.clickhouse_port,
    )
    parser.add_argument(
        "--clickhouse-username", default=default_config.clickhouse_username
    )
    parser.add_argument(
        "--clickhouse-password", default=default_config.clickhouse_password
    )
    parser.add_argument(
        "--clickhouse-database",
        default=default_config.clickhouse_database,
    )
    parser.add_argument(
        "--github-access-token", default=default_config.github_access_token
    )
    parser.add_argument("--github-app-id", default=default_config.github_app_id)
    parser.add_argument("--github-app-secret", default=default_config.github_app_secret)
    parser.add_argument(
        "--github-installation-id",
        type=int,
        default=default_config.github_installation_id,
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be restarted without actually doing it",
    )
    parser.add_argument(
        "--secret-store-name",
        action="store",
        default=default_config.secret_store_name,
        help="Name of the secret in AWS Secrets Manager to fetch GitHub App secret from",
    )

    # no subcommand runs the lambda flow
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    # autorevert-checker subcommand
    workflow_parser = subparsers.add_parser(
        "autorevert-checker",
        help="Analyze workflows for autorevert using Signals (default), or legacy via flag",
    )
    workflow_parser.add_argument(
        "workflows",
        nargs="+",
        default=default_config.workflows,
        help="Workflow name(s) to analyze - single name or comma/space separated"
        + ' list (e.g., "pull" or "pull,trunk,inductor")',
    )
    workflow_parser.add_argument(
        "--hours",
        type=int,
        default=default_config.hours,
        help=f"Lookback window in hours (default: {default_config.hours})",
    )
    workflow_parser.add_argument(
        "--repo-full-name",
        default=default_config.repo_full_name,
        help="Full repo name to filter by (owner/repo).",
    )
    workflow_parser.add_argument(
        "--restart-action",
        type=RestartAction.from_str,
        default=default_config.restart_action,
        choices=list(RestartAction),
        help=(
            "Restart mode: skip (no logging), log (no side effects), or run (dispatch). Default is run."
        ),
    )
    workflow_parser.add_argument(
        "--revert-action",
        type=RevertAction.from_str,
        default=default_config.revert_action,
        choices=list(RevertAction),
        help=(
            "Revert mode: skip, log (no side effects), run-log (prod-style logging), run-notify, or "
            "run-revert. Default is log."
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
        "--bisection-limit",
        type=int,
        default=default_config.bisection_limit,
        help=(
            "Max new pending jobs to schedule per signal to cover gaps (None = unlimited)."
        ),
    )
    workflow_parser.add_argument(
        "--notify-issue-number",
        type=int,
        default=default_config.notify_issue_number,
        help="Issue number to notify",
    )
    workflow_parser.add_argument(
        "--as-of",
        type=str,
        default=None,
        help=(
            "Run as if current time is this timestamp (UTC). "
            "Accepts ISO 8601 or 'YYYY-MM-DD HH:MM[:SS]' format. "
            "Useful for testing autorevert logic at a specific point in time."
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

    # restart-workflow subcommand: dispatch a workflow restart with optional filters
    restart_workflow_parser = subparsers.add_parser(
        "restart-workflow",
        help="Dispatch a workflow restart with optional job/test filters",
    )
    restart_workflow_parser.add_argument(
        "workflow",
        help="Workflow name (e.g., trunk or trunk.yml)",
    )
    restart_workflow_parser.add_argument(
        "commit",
        help="Commit SHA to restart",
    )
    restart_workflow_parser.add_argument(
        "--jobs",
        default=None,
        help="Space-separated job display names to filter (e.g., 'linux-jammy-cuda12.8-py3.10-gcc11')",
    )
    restart_workflow_parser.add_argument(
        "--tests",
        default=None,
        help="Space-separated test module paths to filter (e.g., 'test_torch distributed/test_c10d')",
    )
    restart_workflow_parser.add_argument(
        "--repo-full-name",
        default=default_config.repo_full_name,
        help="Repository in owner/repo format (default: pytorch/pytorch)",
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
        "--workflow",
        default=None,
        help=(
            "Optional workflow filter (e.g. trunk). Only consider run states whose stored workflow"
            " list includes this value."
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


def build_config_from_opts(opts: argparse.Namespace) -> AutorevertConfig:
    """Build an AutorevertConfig from parsed argparse options.

    This function maps the argparse Namespace to the centralized config dataclass,
    handling subcommand-specific attributes that may not be present on all opts.

    Args:
        opts: Parsed argparse.Namespace from the CLI argument parser.

    Returns:
        AutorevertConfig with all values populated from opts.
    """

    def _get(attr: str, default=None):
        """Safely get an attribute from opts, returning default if not present."""
        return getattr(opts, attr, default)

    return AutorevertConfig(
        # ClickHouse Connection Settings
        clickhouse_host=_get("clickhouse_host", DEFAULT_CLICKHOUSE_HOST),
        clickhouse_port=_get("clickhouse_port", DEFAULT_CLICKHOUSE_PORT),
        clickhouse_username=_get("clickhouse_username", ""),
        clickhouse_password=_get("clickhouse_password", ""),
        clickhouse_database=_get("clickhouse_database", DEFAULT_CLICKHOUSE_DATABASE),
        # GitHub Authentication Settings
        github_access_token=_get("github_access_token", ""),
        github_app_id=_get("github_app_id", ""),
        github_app_secret=_get("github_app_secret", ""),
        github_installation_id=int(_get("github_installation_id", "")),
        # AWS Secrets Manager Settings
        secret_store_name=_get("secret_store_name", ""),
        # Autorevert Core Parameters
        repo_full_name=_get("repo_full_name", DEFAULT_REPO_FULL_NAME),
        workflows=_get("workflows", list(DEFAULT_WORKFLOWS)),
        hours=_get("hours", DEFAULT_HOURS),
        notify_issue_number=_get("notify_issue_number", DEFAULT_NOTIFY_ISSUE_NUMBER),
        restart_action=_get("restart_action", None),
        revert_action=_get("revert_action", None),
        bisection_limit=_get("bisection_limit", None),
        as_of=parse_datetime(_get("as_of")) if _get("as_of") else None,
        # Application Settings
        log_level=_get("log_level", DEFAULT_LOG_LEVEL),
        dry_run=_get("dry_run", False),
        subcommand=_get("subcommand", "autorevert-checker"),
        # Circuit Breaker Settings
        circuit_breaker_approved_users=_get(
            "circuit_breaker_approved_users",
            set(DEFAULT_CIRCUIT_BREAKER_APPROVED_USERS),
        ),
        # Subcommand: workflow-restart-checker and restart-workflow
        workflow=_get("workflow", None),
        commit=_get("commit", None),
        days=_get("days", DEFAULT_WORKFLOW_RESTART_DAYS),
        # Subcommand: restart-workflow (filter inputs)
        jobs=_get("jobs", None),
        tests=_get("tests", None),
        # Subcommand: hud
        timestamp=_get("timestamp", None),
        hud_html=_get("hud_html", None),
    )


def build_config_from_event(
    event: dict, default_config: DefaultConfig
) -> AutorevertConfig:
    """Build an AutorevertConfig from an EventBridge event payload.

    This function creates a config by:
    1. Starting with defaults from DefaultConfig (environment variables)
    2. Overriding with any matching parameters from the event JSON
    3. Forcing subcommand to "autorevert-checker"

    Args:
        event: The EventBridge event dict. Parameters matching AutorevertConfig
            field names will be used to override defaults.
        default_config: Configuration loaded from environment variables.

    Returns:
        AutorevertConfig with values from event overriding defaults.
    """
    # Start with defaults from environment
    config_kwargs: dict = {
        # ClickHouse Connection Settings
        "clickhouse_host": default_config.clickhouse_host,
        "clickhouse_port": default_config.clickhouse_port,
        "clickhouse_username": default_config.clickhouse_username,
        "clickhouse_password": default_config.clickhouse_password,
        "clickhouse_database": default_config.clickhouse_database,
        # GitHub Authentication Settings
        "github_access_token": default_config.github_access_token,
        "github_app_id": default_config.github_app_id,
        "github_app_secret": default_config.github_app_secret,
        "github_installation_id": default_config.github_installation_id,
        # AWS Secrets Manager Settings
        "secret_store_name": default_config.secret_store_name,
        # Autorevert Core Parameters
        "repo_full_name": default_config.repo_full_name,
        "workflows": default_config.workflows,
        "hours": default_config.hours,
        "notify_issue_number": default_config.notify_issue_number,
        "restart_action": default_config.restart_action,
        "revert_action": default_config.revert_action,
        "bisection_limit": default_config.bisection_limit,
        "as_of": None,  # Not supported in Lambda invocation
        # Application Settings
        "log_level": default_config.log_level,
        # Force subcommand to autorevert-checker for Lambda
        "subcommand": "autorevert-checker",
        "dry_run": False,
        # Circuit Breaker Settings
        "circuit_breaker_approved_users": default_config.circuit_breaker_approved_users,
    }

    # Keys that are explicitly not allowed to be overridden from event
    ignored_keys = {"subcommand", "dry_run"}

    # Override with values from event if present
    for key, value in event.items():
        if key in ignored_keys:
            logging.warning(
                "Ignoring '%s' from event payload - this parameter cannot be overridden",
                key,
            )
            continue
        if key not in config_kwargs:
            logging.warning(
                "Unknown key '%s' in event payload - check for typos. Valid keys: %s",
                key,
                sorted(config_kwargs.keys()),
            )
            continue
        if value is None:
            continue

        # Handle type conversions for special fields
        if key == "restart_action" and isinstance(value, str):
            config_kwargs[key] = RestartAction.from_str(value)
        elif key == "revert_action" and isinstance(value, str):
            config_kwargs[key] = RevertAction.from_str(value)
        else:
            config_kwargs[key] = value

    return AutorevertConfig(**config_kwargs)


@dataclass
class AWSSecretsFromStore:
    """Secrets retrieved from AWS Secrets Manager.

    Contains sensitive credentials that should not be stored in environment
    variables or code, fetched at runtime from AWS Secrets Manager.

    Attributes:
        github_app_secret: The GitHub App private key (PEM format, decoded from base64).
        clickhouse_password: The ClickHouse database password.
    """

    github_app_secret: str
    clickhouse_password: str


def get_secret_from_aws(secret_store_name: str) -> AWSSecretsFromStore:
    """Retrieve secrets from AWS Secrets Manager.

    Fetches the `secret_store_name` secret which contains:
    - GITHUB_APP_SECRET: Base64-encoded GitHub App private key
    - CLICKHOUSE_PASSWORD: ClickHouse database password

    Uses exponential backoff retry logic for resilience.

    Args:
        secret_store_name: Name of the secret in AWS Secrets Manager

    Returns:
        AWSSecretsFromStore with the decoded secrets.

    Raises:
        SystemExit: If secrets cannot be retrieved after retries.
    """
    try:
        for attempt in RetryWithBackoff():
            with attempt:
                session = boto3.session.Session()
                client = session.client(
                    service_name="secretsmanager", region_name="us-east-1"
                )
                get_secret_value_response = client.get_secret_value(
                    SecretId=secret_store_name
                )
                secret_value_string = json.loads(
                    get_secret_value_response["SecretString"]
                )
                return AWSSecretsFromStore(
                    github_app_secret=base64.b64decode(
                        secret_value_string["GITHUB_APP_SECRET"]
                    ).decode("utf-8"),
                    clickhouse_password=secret_value_string["CLICKHOUSE_PASSWORD"],
                )
    except Exception:
        logging.exception("Failed to retrieve secrets from AWS Secrets Manager")
        sys.exit(1)


def main_cli() -> None:
    """Entry point for CLI invocation (python -m pytorch_auto_revert)."""
    load_dotenv()
    default_config = DefaultConfig()
    opts = get_opts(default_config)
    config = build_config_from_opts(opts)

    main_run(default_config, config, check_circuit_breaker=False)


def main_lambda(event: dict, context: object) -> None:
    """Entry point for AWS Lambda invocation via EventBridge.

    Args:
        event: The event data from EventBridge.
        context: The Lambda context object (provides runtime information).
    """
    default_config = DefaultConfig()
    config = build_config_from_event(event, default_config)

    main_run(default_config, config, check_circuit_breaker=True)


def main_run(
    default_config: DefaultConfig,
    config: AutorevertConfig,
    *,
    check_circuit_breaker: bool,
) -> None:
    """Core execution logic shared by CLI and Lambda entry points.

    Args:
        default_config: Configuration loaded from environment variables.
        config: The unified AutorevertConfig with all settings.
        check_circuit_breaker: If True, check if autorevert is disabled via circuit breaker
            before running. Used by Lambda to allow disabling autorevert via GitHub issue.
    """
    # Track if explicit actions were set via environment variables (for validation)
    env_has_explicit_actions = (
        default_config.restart_action is not None
        or default_config.revert_action is not None
    )

    gh_app_secret = ""
    if config.github_app_secret:
        gh_app_secret = base64.b64decode(config.github_app_secret).decode("utf-8")

    ch_password = config.clickhouse_password

    if config.secret_store_name:
        secrets = get_secret_from_aws(config.secret_store_name)
        gh_app_secret = secrets.github_app_secret
        ch_password = secrets.clickhouse_password

    setup_logging(config.log_level)
    CHCliFactory.setup_client(
        config.clickhouse_host,
        config.clickhouse_port,
        config.clickhouse_username,
        ch_password,
        config.clickhouse_database,
    )
    GHClientFactory.setup_client(
        app_id=config.github_app_id,
        app_secret=gh_app_secret,
        installation_id=config.github_installation_id,
        token=config.github_access_token,
    )

    if not CHCliFactory().connection_test():
        raise RuntimeError(
            "ClickHouse connection test failed. Please check your configuration."
        )

    if config.subcommand == "autorevert-checker":
        if check_circuit_breaker and check_autorevert_disabled(
            config.repo_full_name, config.circuit_breaker_approved_users
        ):
            logging.error(
                "Autorevert is disabled via circuit breaker (ci: disable-autorevert issue found). "
                "Exiting successfully."
            )
            return

        validate_actions_dry_run(config, env_has_explicit_actions)

        _, _, state_json = autorevert_v2(
            config.workflows,
            hours=config.hours,
            notify_issue_number=config.notify_issue_number,
            repo_full_name=config.repo_full_name,
            restart_action=(
                RestartAction.LOG
                if config.dry_run
                else (config.restart_action or RestartAction.RUN)
            ),
            revert_action=(
                RevertAction.LOG
                if config.dry_run
                else (config.revert_action or RevertAction.LOG)
            ),
            bisection_limit=config.bisection_limit,
            as_of=config.as_of,
        )
        write_hud_html_from_cli(config.hud_html, HUD_HTML_NO_VALUE_FLAG, state_json)
    elif config.subcommand == "workflow-restart-checker":
        workflow_restart_checker(
            config.workflow, commit=config.commit, days=config.days
        )
    elif config.subcommand == "restart-workflow":
        dispatch_workflow_restart(
            workflow=config.workflow,
            commit=config.commit,
            jobs=config.jobs,
            tests=config.tests,
            repo=config.repo_full_name,
            dry_run=config.dry_run,
        )
    elif config.subcommand == "hud":
        out_path: Optional[str] = (
            None if config.hud_html is HUD_HTML_NO_VALUE_FLAG else config.hud_html
        )

        # Delegate to testers.hud module
        render_hud_html_from_clickhouse(
            config.timestamp,
            repo_full_name=config.repo_full_name,
            workflow=config.workflow,
            out_path=out_path,
        )


if __name__ == "__main__":
    main_cli()
