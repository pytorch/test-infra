import argparse
import os

import clickhouse_connect


def get_clickhouse_client(
    host: str, port: int, username: str, password: str
) -> clickhouse_connect.driver.client.Client:
    return clickhouse_connect.get_client(
        host=host, port=port, username=username, password=password
    )


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
        "--github-access-token", default=os.environ.get("GITHUB_TOKEN", "")
    )
    return parser.parse_args()


def main(*args, **kwargs) -> None:
    opts = get_opts()
    cc = get_clickhouse_client(
        opts.clickhouse_host,
        opts.clickhouse_port,
        opts.clickhouse_username,
        opts.clickhouse_password,
    )

    print("TODO")


if __name__ == "__main__":
    main()
