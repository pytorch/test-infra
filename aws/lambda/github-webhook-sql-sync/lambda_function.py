import json
import sys
import datetime
import traceback
import asyncio
import os
import hmac
import hashlib
from typing import *
from urllib.parse import unquote
from sqlalchemy import insert, table, column
from sqlalchemy import func
from sqlalchemy.dialects.mysql import insert

from utils import (
    extract_github_objects,
    get_engine,
    transform_data,
    connection_string,
    ACCEPTABLE_WEBHOOKS,
    rprint,
    WEBHOOK_SECRET,
    rprint_buffer,
)


def connection_string():
    host = os.environ["db_host"]
    password = os.environ["db_password"]
    user = os.environ["db_user"]

    return f"mysql+pymysql://{user}:{password}@{host}?charset=utf8mb4"


# user = table("owner",
#         column("id"),
#         column("name"),
#         column("node_id"),
#         column("description"),
# )

# https://chartio.com/resources/tutorials/how-to-execute-raw-sql-in-sqlalchemy/
# metadata = MetaData()
# books = Table('book', metadata,
#   Column('id', Integer, primary_key=True),
#   Column('title', String),
#   Column('primary_author', String),
# )

# engine = create_engine('sqlite:///bookstore.db')
# metadata.create_all(engine)



def upsert(engine, model, insert_dict):
    """model can be a db.Model or a table(), insert_dict should contain a primary or unique key."""
    inserted = insert(model).values(**insert_dict)
    id = None
    # if "node_id" in insert_dict:
    #     breakpoint()
    #     id = func.LAST_INSERT_ID(model.node_id)
    # else:
    #     id = func.LAST_INSERT_ID(model.id)
    upserted = inserted.on_duplicate_key_update(
        **{k: inserted.inserted[k]
                               for k, v in insert_dict.items()})
    res = engine.execute(upserted)
    return res.lastrowid


models = {}

async def handle_webhook(payload: Dict[str, Any], type: str):
    global rprint_buffer
    global models
    rprint_buffer = ""
    # Base = declarative_base()
    engine = get_engine(connection_string())
    # engine.execute(i)
    # print("Running")
    # with engine.connect() as conn:
    #     print(conn.execute(i))
    #     conn.commit()

    # exit(0)

    # Only look at allowlisted webhooks
    if type not in ACCEPTABLE_WEBHOOKS:
        return {"statusCode": 200, "body": f"not processing {type}"}

    # Marshal JSON into SQL-able data
    objects = extract_github_objects(payload, type)

    print("Writing", ", ".join([n for n, o in objects]))


    with engine.connect() as conn:
        for tablename, obj in objects:
            obj = transform_data(obj)
            # if tablename not in models:
            #     model_data = [tablename] + [column(k) for k in obj.keys()]
            #     models[tablename] = table(*model_data)

            # model = models[tablename]
            model_data = [tablename] + [column(k) for k in obj.keys()]
            model = table(*model_data)
            # i = insert(model).values(**obj)
            # i = insert(model).values(**{"node_id": "dog2"})
        #     print("Executed")
                # conn.execute(i)
            upsert(conn, model, obj)
        # break

    # # NB: This has to be before create_all since it passively registers the tables
    # orm_objects = [generate_orm(name, obj, Base) for name, obj in objects]

    # # Set up link to DB
    # session, engine = get_session()
    # Base.metadata.create_all(engine)

    # # Set all the objects on the session
    # # for orm_obj in orm_objects:
    # #     merged = session.merge(orm_obj)
    # #     session.add(merged)

    # # Write to DB
    # session.commit()

    return {"statusCode": 200, "body": "ok"}


def check_hash(payload, expected):
    signature = hmac.new(
        WEBHOOK_SECRET.encode("utf-8"), payload, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)


def save_to_s3(event_type, payload):
    # TODO: Remove this, this is just temporary to gather some testing data
    import boto3

    # s3 = boto3.resource('s3')
    session = boto3.Session(
        aws_access_key_id=os.environ["aws_key_id"],
        aws_secret_access_key=os.environ["aws_access_key"],
    )
    s3 = session.resource("s3")

    now = datetime.datetime.now()
    millis = int(now.timestamp() * 1000)
    day = now.strftime("%Y-%m-%d")
    name = f"pytorch/pytorch/webhooks/{day}/{event_type}-{millis}.json"
    bucket = s3.Bucket("gha-artifacts")
    bucket.put_object(Key=name, Body=json.dumps(payload).encode("utf-8"))


def lambda_handler(event, context):
    # return {"statusCode": 200, "body": "not doing anything"}
    try:
        print("Invoked")
        expected = event["headers"].get("X-Hub-Signature-256", "").split("=")[1]
        payload = event["body"].encode("utf-8")

        if check_hash(payload, expected):
            body = unquote(event["body"])
            if body.startswith("payload="):
                body = body[len("payload=") :]
            payload = json.loads(body)
            event_type = event["headers"]["X-GitHub-Event"]

            if os.getenv("save_to_s3", False) == "1":
                save_to_s3(event_type, payload)

            result = asyncio.run(handle_webhook(payload, event_type))
        else:
            result = {"statusCode": 403, "body": "Forbidden"}

        print("Result:", result)
    except Exception as ex:
        error = traceback.format_exc()
        result = {
            "statusCode": 500,
            "body": rprint_buffer
            + "\n\n"
            + repr(ex)
            + "\n"
            + error
            + "\n\n"
            + event["body"],
        }
        print(result)
        return result
    return result


if os.getenv("DEBUG", "") == "1":
    from pathlib import Path

    name = Path(sys.argv[1])
    with open(name) as f:
        data = json.load(f)
    print(asyncio.run(handle_webhook(data, type=sys.argv[2])))
