import difflib
import json
import os
import sys
from rockset import Client

API_KEY = os.environ["ROCKSET_API_KEY"]
API_SERVER = "https://api.rs2.usw2.rockset.com"

with open("./rockset/prodVersions.json") as f:
    versions = json.load(f)

rs = Client(api_server=API_SERVER, api_key=API_KEY)
failed = False
for query, version in versions.items():
    print(f"Checking that query: {query}:{version} matches your local checkout.")
    qlambda = rs.QueryLambda.retrieveByVersion(
        query, version=version, workspace="commons"
    )
    remote_query = qlambda["sql"]["query"]
    with open(f"./rockset/commons/__sql/{query}.sql") as f:
        local_query = f.read()
        if remote_query != local_query:
            failed = True
            print(f"::error::{query}:{version} does not match your local checkout.")
            diff = difflib.unified_diff(
                remote_query.splitlines(),
                local_query.splitlines(),
                fromfile="Rockset remote query",
                tofile="local checkout",
            )
            for line in diff:
                print(line)

if failed:
    exit(1)
