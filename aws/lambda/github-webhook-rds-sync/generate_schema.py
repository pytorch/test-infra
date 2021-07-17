"""
This script creates and stores the schema needed to hold the data for a set of
webhooks. The webhooks should be in JSON files in a hooks/ directory (see
save_to_s3 in lambda_function.py for the mechanism to gather the hooks). Once
thats done set up the DB connection with the (db_host, db_user, db_password)
env variables and run this script to create classes in SQLAlchemy's ORM and
insert them into the database.

This is intended to be run manually on DB migrations or for testing / restoring
the database.
"""
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

        with open(name) as f:
            data = json.load(f)

        for k, v in data.items():
            webhooks[webhook][k] = v

    # Write all the schemas to the DB
    for webhook, combined_data in webhooks.items():
        r = asyncio.run(update_schema_for(combined_data, webhook=webhook))
