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
