#!/usr/bin/env python3

import argparse
import os

from clickhouse_client_helper import ClickHouseClientFactory


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
        "--clickhouse-database", default=os.environ.get("CLICKHOUSE_DATABASE", "default")
    )
    parser.add_argument(
        "--github-access-token", default=os.environ.get("GITHUB_TOKEN", "")
    )
    return parser.parse_args()


def main(*args, **kwargs) -> None:
    opts = get_opts()
    ClickHouseClientFactory.setup_client(
        opts.clickhouse_host,
        opts.clickhouse_port,
        opts.clickhouse_username,
        opts.clickhouse_password,
        opts.clickhouse_database,
    )

    print(ClickHouseClientFactory().client)


if __name__ == "__main__":
    main()
