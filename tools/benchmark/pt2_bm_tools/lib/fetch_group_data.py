import datetime
from pprint import pprint

import requests
from pt2_bm_tools.data_models.benchmark_query_group_data_model import (  # adjust import as needed
    BenchmarkQueryGroupDataParams,
)
from pydantic import ValidationError


BASE_URLS = {
    "local": "http://localhost:3000",
    "prod": "https://hud.pytorch.org",
}


def fetch_group_data(env: str, req: BenchmarkQueryGroupDataParams):
    url = f"{BASE_URLS[env]}/api/benchmark/group_data/result"
    if env not in BASE_URLS:
        raise ValueError(f"Invalid environment: {env}")
    try:
        # validate format
        datetime.datetime.strptime(req.start_time, "%Y-%m-%dT%H:%M:%S")
        datetime.datetime.strptime(req.end_time, "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        raise ValueError(
            "start_time and end_time must be in format YYYY-MM-DDTHH:MM:SS"
        )
    try:
        params = req.model_dump()
        print(f"Preparing request params: {params}")
    except ValidationError as e:
        print(f"Validation failed: {e}")
        raise

    response = requests.get(url, params=params)
    if response.status_code == 200:
        print("✅ Successfully fetched benchmark data")
        return response.json()
    else:
        print(response.text)
        response.raise_for_status()
        raise Exception("Failed to fetch benchmark data")


def fetch_execubench_group_data(env: str, start_time_str: str, end_time_str: str):
    try:
        params_object = BenchmarkQueryGroupDataParams(
            repo="pytorch/executorch",
            benchmark_name="ExecuTorch",
            start_time=start_time_str,
            end_time=end_time_str,
            group_table_by_fields=["device", "backend", "arch", "model"],
            group_row_by_fields=["workflow_id", "job_id", "granularity_bucket"],
        )
    except ValidationError as e:
        print(f"Validation failed: {e}")
        raise
    return fetch_group_data(env, params_object)
