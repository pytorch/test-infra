
from typing import Optional, Dict, Any, List
import rockset  # type: ignore[import]
import os

def query_rockset(
    query: str, params: Optional[Dict[str, Any]] = None
) -> List[Dict[str, Any]]:
    res: List[Dict[str, Any]] = rockset.RocksetClient(
        host="api.rs2.usw2.rockset.com", api_key=os.environ["ROCKSET_API_KEY"]
    ).sql(query, params=params).results
    return res


def upload_to_rockset(
    collection: str, docs: List[Any], workspace: str = "commons"
) -> None:
    client = rockset.RocksetClient(
        host="api.usw2a1.rockset.com", api_key=os.environ["ROCKSET_API_KEY"]
    )
    client.Documents.add_documents(
        collection=collection,
        data=docs,
        workspace=workspace,
    )
