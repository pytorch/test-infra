import argparse
from datetime import datetime
from pprint import pprint

from pydantic import ValidationError
from pytorch_benchmark_lib.lib.benchmark_execu_query_api import (
    fetch_execu_benchmark_data,
)


def _validate_iso8601_no_ms(value):
    try:
        # Only allow format without milliseconds
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"Invalid datetime format for '{value}'. Expected: YYYY-MM-DDTHH:MM:SS"
        )


def _argparser():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--env", choices=["local", "prod"], default="prod", help="Choose environment"
    )
    parser.add_argument(
        "--startTime",
        type=_validate_iso8601_no_ms,
        required=True,
        help="Start time in ISO format (e.g. 2025-06-01T00:00:00)",
    )
    parser.add_argument(
        "--endTime",
        type=_validate_iso8601_no_ms,
        required=True,
        help="End time in ISO format (e.g. 2025-06-06T00:00:00)",
    )
    return parser.parse_args()


BASE_URLS = {
    "local": "http://localhost:3000",
    "prod": "https://hud.pytorch.org",
}


if __name__ == "__main__":
    args = _argparser()
    url = f"{BASE_URLS[args.env]}/api/benchmark/group_data/execuTorch"

    # Convert back to string in the same format 2025-06-01T00:00:00
    start_time_str = args.startTime.strftime("%Y-%m-%dT%H:%M:%S")
    end_time_str = args.endTime.strftime("%Y-%m-%dT%H:%M:%S")

    resp = fetch_execu_benchmark_data(url, start_time_str, end_time_str)
    group_infos = [job.get("groupInfo", {}) for job in resp]
    print(f"📊 Fetched {len(resp)} table views")
    pprint(group_infos)
    if resp:
        print(f"Peeking first table view: {resp[0]}")
