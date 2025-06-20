#!/usr/bin/env python3

import argparse
import logging
import os
import sys

from dotenv import load_dotenv


# WHY PYTHON WHEN I RUN `python -m package` it is NOT imported as a package?
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from .clickhouse_client_helper import CHCliFactory
from .github_client_helper import GHClientFactory
from .testers.autorevert_checker_tester import autorevert_checker


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

    # no subcommand runs the lambda flow
    subparsers = parser.add_subparsers(dest="subcommand")

    # workflows subcommand
    workflow_parser = subparsers.add_parser("workflows")
    workflow_parser.add_argument(
        "workflows",
        nargs="+",
        help="Workflow name(s) to analyze - single name or comma/space separated"
        + ' list (e.g., "pull" or "pull,trunk,inductor")',
    )
    workflow_parser.add_argument(
        "--hours", type=int, default=48, help="Lookback window in hours (default: 48)"
    )
    workflow_parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Show detailed output including commit summaries",
    )

    return parser.parse_args()


def main(*args, **kwargs) -> None:
    load_dotenv()
    opts = get_opts()
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
        opts.github_app_secret,
        opts.github_installation_id,
        opts.github_access_token,
    )

    if not CHCliFactory().connection_test():
        raise RuntimeError(
            "ClickHouse connection test failed. Please check your configuration."
        )

    try:
        if opts.subcommand == "lambda":
            print("TODO: run lambda flow")
        elif opts.subcommand == "workflows":
            autorevert_checker(opts.workflows, hours=opts.hours, verbose=opts.verbose)
    except Exception as e:
        logging.error(f"An error occurred: {e}")
        import traceback

        traceback.print_exc()
        raise


if __name__ == "__main__":
    main()
