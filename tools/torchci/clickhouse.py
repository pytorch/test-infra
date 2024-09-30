import json
import os
from functools import lru_cache
from typing import Any, Dict, List

import clickhouse_connect
from torchci.utils import cache_json, REPO_ROOT


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


def query_clickhouse(
    query: str, params: Dict[str, Any], use_cache: bool = False
) -> Any:
    """
    Queries ClickHouse.  Returns datetime in YYYY-MM-DD HH:MM:SS format.
    """

    def convert_to_json_list(res: str) -> List[Dict[str, Any]]:
        rows = []
        for row in res.decode().split("\n"):
            if row:
                rows.append(json.loads(row))
        return rows

    if not use_cache:
        res = get_clickhouse_client().raw_query(query, params, fmt="JSONEachRow")
        return convert_to_json_list(res)
    else:

        @cache_json
        def cache_query_clickhouse(query, params):
            res = get_clickhouse_client().raw_query(query, params, fmt="JSONEachRow")
            return convert_to_json_list(res)

        return cache_query_clickhouse(query, params)
