from collections import defaultdict
import json
import asyncio
from pathlib import Path
from typing import *

from sqlalchemy.orm import declarative_base

from utils import (
    extract_github_objects,
    generate_orm,
    get_engine,
    connection_string,
    ACCEPTABLE_WEBHOOKS,
)


async def update_schema_for(payload: Dict[str, Any], webhook: str):
    Base = declarative_base()

    # Only look at allowlisted webhooks
    if webhook not in ACCEPTABLE_WEBHOOKS:
        return {"statusCode": 200, "body": f"not processing {webhook}"}

    # Marshal JSON into SQL-able data
    objects = extract_github_objects(payload, webhook)

    # NB: This has to be before create_all since it passively registers the tables
    [generate_orm(name, obj, Base) for name, obj in objects]

    # # Set up link to DB
    # session, engine = get_session()
    Base.metadata.create_all(get_engine(connection_string()))


if __name__ == "__main__":
    samples_path = Path(__file__).resolve().parent / "hooks"

    webhooks = defaultdict(dict)

    # Go over and combine all webhooks of the same type
    n = len([x for x in samples_path.glob("*.json")])
    for i, name in enumerate(samples_path.glob("*.json")):
        if i % 1000 == 0:
            print(f"{i} / {n}")

        webhook = name.name.replace(".json", "").split("-")[0]
        name = samples_path / name
        if webhook not in ACCEPTABLE_WEBHOOKS:
            continue
        # if webhook != "pull_request":
        #     continue

        with open(name) as f:
            data = json.load(f)

        # Merge the current webhook with the running one, taking the longer of
        # two strings if possible
        # out = webhooks[webhook]
        # webhooks[webhook].update(data)
        for k, v in data.items():
            webhooks[webhook][k] = v
            # if k in out and isinstance(v, str):
            #     if out[k] is None or len(v) > len(out[k]):
            #         out[k] = v
            # else:
            #     out[k] = v

    # print(webhooks.keys())
    # exit(0)
    # Write all the schemas to the DB
    for webhook, combined_data in webhooks.items():
        # if webhook == "pull_request": 
        # print(webhook, " )
        # print(json.dumps(combined_data, indent=2, default=str))
            # breakpoint()
        #     print(json.dumps(combined_data, indent=2, default=str))
        #     exit(0)
        # try:
        r = asyncio.run(update_schema_for(combined_data, webhook=webhook))
        # except Exception as e:
        #     print("Failed on", name)
        #     raise e
