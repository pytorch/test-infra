from functools import lru_cache
import os
from typing import Any, Dict, List, Optional

import rockset  # type: ignore[import]


@lru_cache
def get_rockset_client():
    return rockset.RocksetClient(
        host="api.usw2a1.rockset.com", api_key=os.environ["ROCKSET_API_KEY"]
    )


def query_rockset(
    query: str, params: Optional[Dict[str, Any]] = None
) -> List[Dict[str, Any]]:
    res: List[Dict[str, Any]] = (
        rockset.RocksetClient(
            host="api.rs2.usw2.rockset.com", api_key=os.environ["ROCKSET_API_KEY"]
        )
        .sql(query, params=params)
        .results
    )
    return res


def upload_to_rockset(
    collection: str, docs: List[Any], workspace: str = "commons"
) -> None:
    client = get_rockset_client()
    client.Documents.add_documents(
        collection=collection,
        data=docs,
        workspace=workspace,
    )


def remove_from_rockset(
    collection: str, ids: List[str], workspace: str = "commons"
) -> None:
    client = get_rockset_client()
    ids_to_map = [{"id": id} for id in ids]
    client.Documents.delete_documents(
        collection=collection,
        data=ids_to_map,
        workspace=workspace,
    )
