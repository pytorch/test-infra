import requests
import argparse
import sys
import os
from datetime import datetime
from data_models.benchmark_query_group_data_model import BenchmarkQueryGroupDataParams
from pydantic import ValidationError


def validate_iso8601_no_ms(value):
    try:
        # Only allow format without milliseconds
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"Invalid datetime format for '{value}'. Expected: YYYY-MM-DDTHH:MM:SS"
        )

def argparser():
    parser = argparse.ArgumentParser()
    parser.add_argument('--env', choices=['local', 'prod'], default='prod', help='Choose environment')
    parser.add_argument('--startTime', type=validate_iso8601_no_ms, required=True, help='Start time in ISO format (e.g. 2025-06-01T00:00:00)')
    parser.add_argument('--endTime', type=validate_iso8601_no_ms, required=True, help='End time in ISO format (e.g. 2025-06-06T00:00:00)')
    return  parser.parse_args()

BASE_URLS = {
    "local": "http://localhost:3000",
    "prod": "https://hud.pytorch.org",
}

def main():
    args = argparser()
    url = f"{BASE_URLS[args.env]}/api/benchmark/group_data/execuTorch"

    # Convert back to string in the same format 2025-06-01T00:00:00
    start_time_str = args.startTime.strftime("%Y-%m-%dT%H:%M:%S")
    end_time_str = args.endTime.strftime("%Y-%m-%dT%H:%M:%S")


    try:
        paramsObject = BenchmarkQueryGroupDataParams(
            repo = "pytorch/executorch",
            benchmark_name="ExecuTorch",
            start_time = start_time_str,
            end_time = end_time_str,
            group_table_by_fields= ["device", "backend", "model"],
            group_row_by_fields= ["workflow_id", "job_id", "granularity_bucket"]
        )
        params = paramsObject.model_dump()
        print(f"preparing request paranns: {params}")
    except ValidationError as e:
        print(f"Validation failed, {e}")
        raise

    response = requests.get(url, params=params)
    if response.status_code == 200:
        print("Successfully fetched benchmark data")
        resp = response.json()
        print(f"fetched {len(resp)} table views")
        print(f"peeking first table view, peeking.... {resp[0]} ")
    else:
        print(f"Failed to fetch benchmark data ({response.status_code})")
        print(response.text)

if __name__ == '__main__':
    main()
