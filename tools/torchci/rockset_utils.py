import os
from functools import lru_cache
from typing import Any, Dict, List, Optional

import rockset
from torchci.utils import cache_json  # type: ignore[import]


@lru_cache
def get_rockset_client():
    return rockset.RocksetClient(
        host="api.usw2a1.rockset.com", api_key=os.environ["ROCKSET_API_KEY"]
    )


def query_rockset(
    query: str, params: Optional[Dict[str, Any]] = None, use_cache: bool = False
) -> List[Dict[str, Any]]:
    if not use_cache:
        return get_rockset_client().sql(query, params=params).results

    @cache_json
    def cache_query_rockset(query, params):
        return get_rockset_client().sql(query, params=params).results

    return cache_query_rockset(query, params)
