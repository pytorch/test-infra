from collections import defaultdict
import json
import math
import os

from rockset import Client, ParamDict
import pandas as pd


ROCKSET_API_KEY = os.environ.get("ROCKSET_API_KEY")
if ROCKSET_API_KEY is None:
    raise RuntimeError("ROCKSET_API_KEY not set")

client = Client(
    api_key=ROCKSET_API_KEY,
    api_server="https://api.rs2.usw2.rockset.com",
)
qlambda = client.QueryLambda.retrieve(
    "correlation_matrix", version="4960260cbb0c5b48", workspace="metrics"
)

params = ParamDict()
results = qlambda.execute(parameters=params)

pivot = defaultdict(dict)

# Results look like (is_green, head_sha, name)
# Turn results into a nested dict of head_sha => name => is_green
for result in results.results:
    # skip pending jobs
    if result["is_green"] is None:
        continue

    head_sha = result["head_sha"]
    if head_sha not in pivot:
        pivot[head_sha] = {}

    name = result["name"]

    # only consider the root job name, as opposed to the build/test shards.
    name = name.partition(" / ")[0]
    if name not in pivot[head_sha]:
        pivot[head_sha][name] = 1

    pivot[head_sha][name] *= result["is_green"]

df = pd.DataFrame(pivot).transpose()
correlation_matrix = df.corr()

print(correlation_matrix)

# Prepare for rendering in json:
# Turn the nested dict of name => name => corr to Array<xAxis, yAxis, corr>
correlation_matrix = correlation_matrix.to_dict()
data = []

for xIdx, xName in enumerate(correlation_matrix):
    for yIdx, yName in enumerate(correlation_matrix[xName]):
        value = correlation_matrix[xName][yName]
        # nans mean we couldn't find any examples with both jobs populated.
        if math.isnan(value):
            continue

        data.append((xIdx, yIdx, value))

with open("lib/correlation_matrix.json", "w") as f:
    json.dump({"names": list(correlation_matrix.keys()), "data": data}, f)
