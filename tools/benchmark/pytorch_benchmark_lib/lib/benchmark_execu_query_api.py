from pprint import pprint

import requests
from pydantic import ValidationError
from pytorch_benchmark_lib.data_models.benchmark_query_group_data_model import (  # adjust import as needed
    BenchmarkQueryGroupDataParams,
)


def fetch_execu_benchmark_data(url: str, start_time_str: str, end_time_str: str):
    try:
        params_object = BenchmarkQueryGroupDataParams(
            repo="pytorch/executorch",
            benchmark_name="ExecuTorch",
            start_time=start_time_str,
            end_time=end_time_str,
            group_table_by_fields=["device", "backend", "arch", "model"],
            group_row_by_fields=["workflow_id", "job_id", "granularity_bucket"],
        )
        params = params_object.model_dump()
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
