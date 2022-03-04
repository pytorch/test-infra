import json
from rockset import Client

with open("./rockset/prodVersions.json") as f:
    versions = json.load(f)

rs = Client()
for query, version in versions.items():
    print(f"Tagging commons.{query}:{version} with tag 'prod'")
    qlambda = rs.QueryLambda.retrieveByVersion(
        query, version=version, workspace="commons"
    )
    qlambda.tag("prod")
