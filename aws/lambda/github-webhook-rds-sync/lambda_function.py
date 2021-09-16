import json
import datetime
import asyncio
import os
import boto3
import hmac
import hashlib
from typing import *
from sqlalchemy import insert, table, column
from sqlalchemy.dialects.mysql import insert

from utils import (
    extract_github_objects,
    get_engine,
    transform_data,
    connection_string,
    WEBHOOK_SECRET,
)

from existing_schema import existing_schema


def upsert(engine, model, insert_dict):
    """
    Insert or update to an engine backed by MySQL
    """
    inserted = insert(model).values(**insert_dict)
    upserted = inserted.on_duplicate_key_update(
        **{k: inserted.inserted[k] for k, v in insert_dict.items()}
    )
    res = engine.execute(upserted)
    return res.lastrowid


async def handle_webhook(payload: Dict[str, Any], type: str):
    engine = get_engine(connection_string())

    # Marshal JSON into SQL-able data
    objects = extract_github_objects(payload, type)

    print("Writing", ", ".join([n for n, o in objects]))

    with engine.connect() as conn:
        for tablename, obj in objects:
            # Some of the data is not already in the right form (e.g. dates and
            # lists, so fix that up here)
            obj = transform_data(obj)

            model_data = [tablename] + [column(k) for k in obj.keys()]
            model = table(*model_data)

            if tablename not in existing_schema:
                print(
                    f"Skipping write of {tablename} since it doesn't exist in hardcoded schema"
                )
                continue

            # Remove non-existent fields
            newdata = {}
            for key, value in obj.items():
                if key in existing_schema[tablename]:
                    newdata[key] = value
                else:
                    print(
                        f"Dropping key '{key}' with value '{value}' since it doesn't exist in table {tablename}"
                    )
            obj = newdata
            upsert(conn, model, obj)

    return {"statusCode": 200, "body": "ok"}


def check_hash(payload, expected):
    signature = hmac.new(
        WEBHOOK_SECRET.encode("utf-8"), payload, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)


def save_to_s3(event_type, payload):
    """
    Save a webhook payload to S3 in gha-artifacts/webhooks (used
    in generate_schema.py)
    """
    session = boto3.Session(
        aws_access_key_id=os.environ["aws_key_id"],
        aws_secret_access_key=os.environ["aws_access_key"],
    )
    s3 = session.resource("s3")

    now = datetime.datetime.now()
    millis = int(now.timestamp() * 1000)
    day = now.strftime("%Y-%m-%d")
    name = f"webhooks/{day}/{event_type}-{millis}.json"
    bucket = s3.Bucket("gha-artifacts")
    bucket.put_object(Key=name, Body=json.dumps(payload).encode("utf-8"))


def lambda_handler(event, context):
    expected = event["headers"].get("X-Hub-Signature-256", "").split("=")[1]
    payload = event["body"].encode("utf-8")

    # Check that the signature matches the secret on GitHub
    if check_hash(payload, expected):
        body = event["body"]
        if body.startswith("payload="):
            body = body[len("payload=") :]
        try:
            payload = json.loads(body)
        except Exception as e:
            raise RuntimeError(f"Failed to decode JSON:\n{str(e)}\n\n{body}\n\n{event}")

        # Pull out the webhook type (e.g. pull_request, issues, check_run, etc)
        event_type = event["headers"]["X-GitHub-Event"]

        # If we want to, save webhooks to S3 for later processing (this is used
        # to generate the DB schema with generate_schema.py
        if os.getenv("save_to_s3", False) == "1":
            save_to_s3(event_type, payload)

        if os.getenv("write_to_db", "1") == "1":
            result = asyncio.run(handle_webhook(payload, event_type))
        else:
            result = {"statusCode": 200, "body": "didn't write"}
    else:
        result = {"statusCode": 403, "body": "Forbidden"}

    print("Result:", result)
    return result
