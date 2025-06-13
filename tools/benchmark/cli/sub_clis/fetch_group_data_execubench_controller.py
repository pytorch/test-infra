import argparse
from datetime import datetime
from pprint import pprint

from pt2_bm_tools.lib.fetch_group_data import fetch_execubench_group_data


def run_execubench(env: str, start_time: str, end_time: str):
    """
    Args:
        env (str): "local" or "prod"
        start_time (str): ISO8601 string without milliseconds
        end_time (str): ISO8601 string without milliseconds
    """
    resp = fetch_execubench_group_data(env, start_time, end_time)
    group_infos = [job.get("groupInfo", {}) for job in resp]
    print(f"Fetched {len(resp)} table views")
    pprint(group_infos)
    if resp:
        print(f"Peeking first table view: {resp[0]}")


def main():
    parser = argparse.ArgumentParser(description="Run execubench group-data-query")
    parser.add_argument(
        "--env", choices=["local", "prod"], default="prod", help="Environment"
    )
    parser.add_argument(
        "--startTime", required=True, help="Start time in YYYY-MM-DDTHH:MM:SS"
    )
    parser.add_argument(
        "--endTime", required=True, help="End time in YYYY-MM-DDTHH:MM:SS"
    )
    args = parser.parse_args()

    run_execubench(
        env=args.env,
        start_time=args.startTime,
        end_time=args.endTime,
    )


if __name__ == "__main__":
    main()
