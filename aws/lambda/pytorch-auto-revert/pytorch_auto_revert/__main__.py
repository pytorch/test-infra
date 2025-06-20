#!/usr/bin/env python3

import argparse
import os

from clickhouse_client_helper import CHCliFactory
from dotenv import load_dotenv
from github_client_helper import GHClientFactory


def get_opts() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
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
        default=int(default=os.environ.get("GITHUB_INSTALLATION_ID", "")),
    )
    return parser.parse_args()


def main(*args, **kwargs) -> None:
    load_dotenv()
    opts = get_opts()
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

    if not CHCliFactory().client.connection_test():
        raise RuntimeError(
            "ClickHouse connection test failed. Please check your configuration."
        )


if __name__ == "__main__":
    main()
