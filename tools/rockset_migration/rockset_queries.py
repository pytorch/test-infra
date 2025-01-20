#!/usr/bin/env python
# coding: utf-8

# # Parse and cleanup Rockset query lambdas and collections
# This code is for analyzing Rockset query lambdas and collections to help determine
# how critical each one is to our infrastructure
#
# We'll also use this to delete some query lambdas that are clearly not used
#
# Note: rockset_queries.py is generated from rockset_queries.ipynb with the command:
# `jupyter nbconvert --to script rockset_queries.ipynb`.  It is there just
# for ease of code reviews, any edits/execution is intended to occur in
# rockset_queries.ipynb (which is the source of truth)

# In[ ]:


import datetime
import json
import os
from pathlib import Path
from typing import Any, Dict, List, NamedTuple

import requests


ROCKSET_API_KEY = os.environ.get("ROCKSET_API_KEY")

# In[ ]:


class LambdaQuery(NamedTuple):
    name: str
    workspace: str
    state: str
    created_at: str
    last_updated: str
    last_updated_by: str
    version_count: int
    collections: List[str]
    last_executed: str
    last_execution_error: str
    description: str
    human_description: str
    sql: Dict[str, Any]
    raw_response: Dict[str, Any]

    def printfields(self, fields: List[str]) -> None:
        print(f"Query: {self.workspace}.{self.name}")
        for field in fields:
            print(f"  {field}: {getattr(self, field)}")


def get_description_from_query_sql(sql: str) -> str:
    """
    Some queries have a description in the top lines of the SQL.
    This function checks for that and returns the description.
    """
    lines = sql.split("\n")
    description = ""
    for line in lines:
        # Ignore if blank or whitespace line
        if not line.strip():
            continue

        if line.startswith("--"):
            # skip all the leading "-" characters
            description += line.lstrip("-").strip() + " "
        else:
            # We've reached actual code
            break
    return description.strip()


def get_query_lambdas() -> Dict[str, LambdaQuery]:
    url = "https://api.usw2a1.rockset.com/v1/orgs/self/lambdas"

    headers = {
        "accept": "application/json",
        "Authorization": f"ApiKey {ROCKSET_API_KEY}",
    }

    response = requests.get(url, headers=headers)
    data = json.loads(response.text)

    queries = {}
    for lambdaquery in data["data"]:
        queries[f"{lambdaquery['workspace']}.{lambdaquery['name']}"] = LambdaQuery(
            name=lambdaquery["name"],
            workspace=lambdaquery["workspace"],
            state=lambdaquery["latest_version"]["state"],
            created_at=lambdaquery["latest_version"]["created_at"],
            last_updated=lambdaquery["last_updated"],
            last_updated_by=lambdaquery["last_updated_by"],
            version_count=lambdaquery["version_count"],
            collections=lambdaquery["latest_version"]["collections"],
            last_executed=lambdaquery["latest_version"]["stats"]["last_executed"],
            last_execution_error=lambdaquery["latest_version"]["stats"][
                "last_execution_error"
            ],
            description=lambdaquery["latest_version"]["description"],
            human_description=get_description_from_query_sql(
                lambdaquery["latest_version"]["sql"]["query"]
            ),
            sql=lambdaquery["latest_version"]["sql"],
            raw_response=lambdaquery,
        )

    return queries


# In[ ]:


class Collections(NamedTuple):
    name: str
    workspace: str
    created_at: str
    created_by: str
    last_queried: str
    last_queried_raw: int
    doc_count: int
    description: str
    status: str
    size: int
    raw_response: Dict[str, Any]


def get_collections() -> Dict[str, Collections]:
    url = "https://api.usw2a1.rockset.com/v1/orgs/self/collections"
    headers = {
        "accept": "application/json",
        "Authorization": f"ApiKey {ROCKSET_API_KEY}",
    }
    response = requests.get(url, headers=headers)
    data = json.loads(response.text)
    print(json.dumps(data, indent=2))

    collections = {}
    for collection in data["data"]:
        # skip the collection "commons._events" since it's not a user-created collection
        if collection["workspace"] == "commons" and collection["name"] == "_events":
            continue

        collections[f"{collection['workspace']}.{collection['name']}"] = Collections(
            name=collection["name"],
            workspace=collection["workspace"],
            created_at=collection["created_at"],
            created_by=collection["created_by"],
            last_queried=str(
                datetime.datetime.fromtimestamp(
                    collection["stats"]["last_queried_ms"] / 1000
                )
            ),
            last_queried_raw=collection["stats"]["last_queried_ms"],
            size=collection["stats"]["total_size"],
            doc_count=collection["stats"]["doc_count"],
            description=collection.get("description", ""),
            status=collection["status"],
            raw_response=collection,
        )

    # sort collections by key
    collections = dict(sorted(collections.items()))
    return collections


#

# In[ ]:


def print_human_descriptions(queries: Dict[str, LambdaQuery]) -> None:
    for k, query in queries.items():
        if query.human_description:
            print(f"{k}:\n {query.human_description}")


def have_human_descriptions(queries: Dict[str, LambdaQuery]) -> Dict[str, LambdaQuery]:
    """Returns a dict of queries that have human descriptions"""
    return {k: v for k, v in queries.items() if v.human_description}


def inactive_queries(queries: Dict[str, LambdaQuery]) -> Dict[str, LambdaQuery]:
    return {k: v for k, v in queries.items() if v.state != "ACTIVE"}


def not_run(info: Dict[str, LambdaQuery]) -> Dict[str, LambdaQuery]:
    """Queries that have never been run."""
    return {k: v for k, v in info.items() if v.last_executed is None}


def not_recently_run(info: Dict[str, LambdaQuery], days: int) -> Dict[str, LambdaQuery]:
    """Queries that have not been run in the last `days` days."""
    cutoff = datetime.datetime.now() - datetime.timedelta(days=days)
    return {
        k: v
        for k, v in info.items()
        if v.last_executed is not None
        and datetime.datetime.strptime(v.last_executed, "%Y-%m-%dT%H:%M:%SZ") < cutoff
    }


def queries_run_recently(
    queries: Dict[str, LambdaQuery], days: int
) -> Dict[str, LambdaQuery]:
    """Queries that have been run in the last `days` days."""
    cutoff = datetime.datetime.now() - datetime.timedelta(days=days)
    return {
        k: v
        for k, v in queries.items()
        if v.last_executed is not None
        and datetime.datetime.strptime(v.last_executed, "%Y-%m-%dT%H:%M:%SZ") > cutoff
    }


def not_in(
    queries: Dict[str, LambdaQuery], excepting: Dict[str, LambdaQuery]
) -> Dict[str, LambdaQuery]:
    """Returns LambdaQueries that are not in the excepting dictionary."""
    return {k: v for k, v in queries.items() if k not in excepting}


# In[ ]:


def delete_lambda(query: LambdaQuery) -> None:
    url = f"https://api.usw2a1.rockset.com/v1/orgs/self/ws/{query.workspace}/lambdas/{query.name}"

    headers = {
        "accept": "application/json",
        "Authorization": f"ApiKey {ROCKSET_API_KEY}",
    }

    response = requests.delete(url, headers=headers)
    print(response.text)


def backup_lambdas(queries: Dict[str, LambdaQuery], dir: Path) -> None:
    # Create dir if it doesn't exist
    dir.mkdir(parents=True, exist_ok=True)
    for query in queries.values():
        with open(dir / f"{query.workspace}.{query.name}.sql.json", "w") as f:
            f.write(json.dumps(query.sql, indent=2))
        with open(dir / f"{query.workspace}.{query.name}.raw.json", "w") as f:
            f.write(json.dumps(query.raw_response, indent=2))


# In[ ]:

if __name__ == "__main__":
    queries = get_query_lambdas()

    # In[ ]:

    backup_lambdas(queries, Path("lambdas_backup"))

    # In[ ]:

    prob_unneeded = {
        **not_run(queries),
        **not_recently_run(queries, 60),
    }

    # In[ ]:

    # This code will be used to delete unused lambads, 10 at a time

    # # Deletes lambadas that have never been run
    # deletable = not_run(queries)

    # # Sort deletable by their last updated date
    # deletable = dict(sorted(deletable.items(), key=lambda x: x[1].last_updated))

    # # We'll delete the first 10 queries
    # for k, v in list(deletable.items())[:10]:
    #     print(f"Deleting {k}")
    #     delete_lambda(v)

    # In[ ]:

    important_queries = not_in(queries, prob_unneeded)

    len(have_human_descriptions(important_queries))

    # In[ ]:

    def printq(queries: Dict[str, LambdaQuery], fields: List[str]) -> None:
        for query in queries.values():
            query.printfields(fields)
            print()

    def print_query_descriptions(queries: Dict[str, LambdaQuery]) -> None:
        for query in queries.values():
            print(f"{query.workspace}.{query.name}", end="")
            if query.human_description:
                print(f" - {query.human_description}")
            elif query.description:
                print(f" - {query.description}")
            else:
                print()

    occasionally_run = not_in(important_queries, queries_run_recently(queries, 7))
    len(occasionally_run)

    # In[ ]:

    collections = get_collections()
    len(collections)

    # In[ ]:

    # List all collections in collections that are not in any collection
    # used by the important_queries
    def unused_collections(
        collections: Dict[str, Collections], queries: Dict[str, LambdaQuery]
    ) -> Dict[str, Collections]:
        used_collections = set()
        for query in queries.values():
            used_collections.update(query.collections)
        return {k: v for k, v in collections.items() if k not in used_collections}

    def used_collections(
        collections: Dict[str, Collections], queries: Dict[str, LambdaQuery]
    ) -> Dict[str, Collections]:
        used_collections = set()
        for query in queries.values():
            used_collections.update(query.collections)
        return {k: v for k, v in collections.items() if k in used_collections}

    print("Used collections:")
    for collection in used_collections(collections, important_queries).values():
        print(f"{collection.workspace}.{collection.name}")

        print("\nUnused collections:")
        for collection in unused_collections(collections, important_queries).values():
            print(f"{collection.workspace}.{collection.name}")
