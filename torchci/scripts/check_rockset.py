import json
from rockset import Client

with open("./rockset/prodVersions.json") as f:
    versions = json.load(f)

rs = Client()
for query, version in versions.items():
    print(f"Checking that query: {query}:{version} matches your local checkout.")
    qlambda = rs.QueryLambda.retrieveByVersion(
        query, version=version, workspace="commons"
    )
    remote_query = qlambda["sql"]["query"]
    with open(f"./rockset/commons/__sql/{query}.sql") as f:
        if remote_query != f.read():
            print(f"::error::{query}:{version} does not match your local checkout.")

