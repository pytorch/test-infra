"""Centralized configuration options for the pytorch-auto-revert system.

This module provides a single dataclass that consolidates all configuration
options from environment variables, CLI arguments, and defaults into one
unified interface.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from .utils import RestartAction, RevertAction


# Default values as constants for easy reference and testing
DEFAULT_CLICKHOUSE_HOST = "localhost"
DEFAULT_CLICKHOUSE_PORT = 8443
DEFAULT_CLICKHOUSE_DATABASE = "default"
DEFAULT_HOURS = 16
DEFAULT_LOG_LEVEL = "INFO"
DEFAULT_NOTIFY_ISSUE_NUMBER = 163650  # https://github.com/pytorch/pytorch/issues/163650
DEFAULT_REPO_FULL_NAME = "pytorch/pytorch"
DEFAULT_WORKFLOWS = ["Lint", "trunk", "pull", "inductor", "linux-aarch64", "slow"]
DEFAULT_WORKFLOW_RESTART_DAYS = 7
# Users authorized to disable autorevert via circuit breaker issue
DEFAULT_CIRCUIT_BREAKER_APPROVED_USERS: set[str] = set(
    "albanD",
    "atalman",
    "drisspg",
    "ezyang",
    "huydhn",
    "izaitsevfb",
    "janeyx99",
    "jeanschmidt",
    "malfet",
    "seemethere",
    "wdvr",
    "yangw-dev",
    "ZainRizvi",
)


@dataclass
class AutorevertConfig:
    """Centralized configuration for the pytorch-auto-revert system.

    This dataclass consolidates all configuration options that can be provided
    via environment variables, CLI arguments, or programmatically.

    Attributes are grouped into logical sections:
    - ClickHouse connection settings
    - GitHub authentication settings
    - AWS Secrets Manager settings
    - Autorevert core parameters
    - Application settings
    - Subcommand-specific settings
    """

    # -------------------------------------------------------------------------
    # ClickHouse Connection Settings
    # -------------------------------------------------------------------------
    clickhouse_host: str = DEFAULT_CLICKHOUSE_HOST
    clickhouse_port: int = DEFAULT_CLICKHOUSE_PORT
    clickhouse_username: str = ""
    clickhouse_password: str = ""
    clickhouse_database: str = DEFAULT_CLICKHOUSE_DATABASE

    # -------------------------------------------------------------------------
    # GitHub Authentication Settings
    # -------------------------------------------------------------------------
    github_access_token: str = ""
    github_app_id: str = ""
    github_app_secret: str = ""
    github_installation_id: int = 0

    # -------------------------------------------------------------------------
    # AWS Secrets Manager Settings
    # -------------------------------------------------------------------------
    secret_store_name: str = ""

    # -------------------------------------------------------------------------
    # Autorevert Core Parameters
    # -------------------------------------------------------------------------
    repo_full_name: str = DEFAULT_REPO_FULL_NAME
    workflows: list[str] = field(default_factory=lambda: list(DEFAULT_WORKFLOWS))
    hours: int = DEFAULT_HOURS
    notify_issue_number: int = DEFAULT_NOTIFY_ISSUE_NUMBER
    restart_action: Optional[RestartAction] = None
    revert_action: Optional[RevertAction] = None
    bisection_limit: Optional[int] = None
    as_of: Optional[datetime] = None

    # -------------------------------------------------------------------------
    # Application Settings
    # -------------------------------------------------------------------------
    log_level: str = DEFAULT_LOG_LEVEL
    dry_run: bool = False
    subcommand: str = "autorevert-checker"

    # -------------------------------------------------------------------------
    # Circuit Breaker Settings
    # -------------------------------------------------------------------------
    circuit_breaker_approved_users: set[str] = field(
        default_factory=lambda: set(DEFAULT_CIRCUIT_BREAKER_APPROVED_USERS)
    )

    # -------------------------------------------------------------------------
    # Subcommand: workflow-restart-checker and restart-workflow
    # -------------------------------------------------------------------------
    workflow: Optional[str] = None
    commit: Optional[str] = None
    days: int = DEFAULT_WORKFLOW_RESTART_DAYS

    # -------------------------------------------------------------------------
    # Subcommand: restart-workflow (filter inputs)
    # -------------------------------------------------------------------------
    jobs: Optional[str] = None  # Space-separated job display names
    tests: Optional[str] = None  # Space-separated test module paths

    # -------------------------------------------------------------------------
    # Subcommand: hud
    # -------------------------------------------------------------------------
    timestamp: Optional[str] = None
    hud_html: Optional[str] = None
