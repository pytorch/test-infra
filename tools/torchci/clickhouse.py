import json
import os
from functools import lru_cache
from typing import Any, Dict

import clickhouse_connect
from torchci.utils import REPO_ROOT


@lru_cache(maxsize=1)
def get_clickhouse_client() -> Any:
    endpoint = os.environ["CLICKHOUSE_ENDPOINT"]
    # I cannot figure out why these values aren't being handled automatically
    # when it is fine in the lambda
    if endpoint.startswith("https://"):
        endpoint = endpoint[len("https://") :]
    if endpoint.endswith(":8443"):
        endpoint = endpoint[: -len(":8443")]
    return clickhouse_connect.get_client(
        host=endpoint,
        user=os.environ["CLICKHOUSE_USERNAME"],
        password=os.environ["CLICKHOUSE_PASSWORD"],
        secure=True,
        interface="https",
        port=8443,
    )


def query_clickhouse_saved(queryName: str, inputParams: Dict[str, Any]) -> Any:
    path = REPO_ROOT / "torchci" / "clickhouse_queries" / queryName
    with open(path / "query.sql") as f:
        queryText = f.read()
    with open(path / "params.json") as f:
        paramsText = json.load(f)

    queryParams = {name: inputParams[name] for name in paramsText}
    return query_clickhouse(queryText, queryParams)


def query_clickhouse(query: str, params: Dict[str, Any]) -> Any:
    res = get_clickhouse_client().query(query, params)
    json_res = []
    # convert to json
    for row in res.result_rows:
        json_row = {}
        for i, column in enumerate(res.column_names):
            json_row[column] = row[i]
        json_res.append(json_row)
    return json_res
