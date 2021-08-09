import json
import sys
import pymysql
import datetime
from dateutil import parser
import traceback
import asyncio
import os
import hmac
import hashlib
from typing import *
from urllib.parse import unquote


from sqlalchemy import create_engine, schema
from sqlalchemy.orm import declarative_base
from sqlalchemy.orm import relationship
from sqlalchemy import (
    Column,
    Integer,
    String,
    Boolean,
    DateTime,
    Table,
    ForeignKey,
    JSON,
    Text,
)
from sqlalchemy.sql.schema import ForeignKey
from sqlalchemy.sql.sqltypes import Date
from sqlalchemy.orm import sessionmaker

# We're just going to dump the webhook straight into mysql by flattening out the
# JSON object and inlining arrays into JSON strings
FlatDict = Dict[str, Union[str, int]]

WEBHOOK_SECRET = os.environ["gh_secret"]

OBJECT_PLACEHOLDER = object()

type_map = {
    "repository": {
        "description": lambda: Column(String(300)),
        "homepage": lambda: Column(String(300)),
        "license": lambda: Column(String(300)),
        "mirror_url": lambda: Column(String(300)),
        "master_branch": lambda: Column(String(300)),
        "stargazers": lambda: Column(Integer),
    },
    "issues_event": {"changes_title_from": lambda: Column(String(300)), "changes_body_from": lambda: Column(Text)},
    "push_event": {"base_ref": lambda: Column(String(300)),},
    "issue": {
        "assignee": lambda: OBJECT_PLACEHOLDER,
        "milestone": lambda: OBJECT_PLACEHOLDER,
        "closed_at": lambda: Column(DateTime),
        "active_lock_reason": lambda: Column(String(100)),
        "performed_via_github_app": lambda: Column(Boolean),
    },
    "owner": {
        "name": lambda: Column(String(100)),
        "email": lambda: Column(String(100)),
    },
    "create_event": {"description": lambda: Column(String(100)),},
    "check_suite": {"conclusion": lambda: Column(String(100)),},
    "pull_request": {
        "body": lambda: Column(Text),
        "milestone": lambda: Column(String(100)),
        "head_repo_description": lambda: Column(Text),
        "head_repo_homepage": lambda: Column(String(100)),
        "head_repo_mirror_url": lambda: Column(String(100)),
        "head_repo_license": lambda: Column(String(100)),
        "base_repo_description": lambda: Column(Text),
        "base_repo_homepage": lambda: Column(String(100)),
        "base_repo_mirror_url": lambda: Column(String(100)),
        "base_repo_license": lambda: Column(String(100)),
        "auto_merge": lambda: Column(String(100)),
        "active_lock_reason": lambda: Column(String(100)),
        "mergeable": lambda: Column(Boolean),
        "rebaseable": lambda: Column(Boolean),
        "merged_by": lambda: Column(String(100)),
        "merge_commit_sha": lambda: Column(String(100)),
        "assignee": lambda: Column(String(100)),
    },
}


def flatten_object(obj: Dict[str, Any]) -> FlatDict:
    """
    Take an object and inline all the fields so it doesn't have any nesting
    """
    result = {}

    def helper(curr: Dict[str, Any], name: List[str]):
        for key, value in curr.items():
            if key.endswith("_url"):
                # These add basically nothing so just skip them
                continue

            full_name = "_".join(name + [key])
            if isinstance(value, (str, int, bool)):
                result[full_name] = value
            elif isinstance(value, list):
                result[full_name] = value
            elif isinstance(value, dict):
                helper(value, name + [key])
            elif value is None:
                result[full_name] = value
            else:
                raise RuntimeError(f"Unknown type on {full_name}: {value}")

    helper(obj, [])
    return result


def extract_github_objects(obj: Dict[str, Any], obj_name: str) -> List[FlatDict]:
    """
    GitHub's real 'objects' (i.e. things accessible in the API) all have a
    unique "node_id" string. This descends into an object and pulls out anything
    with a node_id and removes it from the parent. It also flattens the objects
    from a Dict[str, Any] to a Dict[str, str] (with an exception for lists so we
    still know later on that they're lists and not ordinary strings)
    """
    objects = []

    def helper(curr: Dict[str, Any], name: str):
        node_ids_to_add = []
        keys_to_delete = []
        for key, value in curr.items():
            if isinstance(value, dict) and "node_id" in value:
                node_ids_to_add.append((f"{key}_node_id", value["node_id"]))
                # del value["node_id"]
                keys_to_delete.append(key)
                helper(value, key)
                objects.append((key, flatten_object(value)))

        for key in keys_to_delete:
            del curr[key]

        for name, node_id in node_ids_to_add:
            curr[name] = node_id

    helper(obj, [])
    objects.append((f"{obj_name}_event", flatten_object(obj)))

    for _, object in objects:
        object["sync_last_update_at"] = datetime.datetime.now()
    # print(json.dumps(objects, indent=2))
    return objects


def get_column(key: str, value: Any, type_name: str):
    if key in type_map.get(type_name, {}):
        return type_map[type_name][key]()
    if is_date(key, value):
        return Column(DateTime)
    if isinstance(value, str):
        return Column(String(max(30, len(value) * 10)))
    if isinstance(value, int):
        return Column(Integer)
    if isinstance(value, bool):
        return Column(Boolean)
    if isinstance(value, list):
        return Column(JSON)
    else:
        return None
        raise RuntimeError(f"Unknown type {type_name}.{key}: {value}")


x = ""


def rprint(s):
    global x
    x += "\n" + str(s)


def is_date(key: str, value: Any) -> bool:
    return key.endswith("_at") or key.endswith("timestamp")


def get_pk(obj: FlatDict) -> Tuple[str, Column]:
    if "node_id" in obj:
        return "node_id", Column(String(50), primary_key=True)

    return "pk_id", Column(Integer, primary_key=True)


def generate_orm(name: str, obj: FlatDict, sql_base: Any) -> Any:
    columns = {"__tablename__": name, "__table_args__": {"extend_existing": True}}
    errors = []
    for key, value in obj.items():
        col = get_column(key, value, type_name=name)
        if col is OBJECT_PLACEHOLDER:
            # There is a null object (with a node_id) missing, so create it as
            # we would if something was there but leave the value blank
            columns[f"{key}_node_id"] = Column(String(50))
        elif col is None:
            errors.append(f"{name}.{key}: {value}")
        else:
            columns[key] = col

    if len(errors) > 0:
        catted_errors = "\n    ".join(errors)
        raise RuntimeError(f"Unknown types:\n{catted_errors}")

    # Fill in any inconsistent / missing columns from the GitHub API
    for key, column_creator in type_map.get(name, {}).items():
        columns[key] = column_creator()
        # value = column_creator()

    # transform lists into JSON
    for key, value in obj.items():
        if isinstance(value, list):
            obj[key] = json.dumps(value)
        elif is_date(key, value) and value is not None:
            if isinstance(value, int):
                # convert from timestamp
                obj[key] = datetime.datetime.fromtimestamp(value)
            elif isinstance(value, datetime.datetime):
                obj[key] = value
            elif isinstance(value, str):
                obj[key] = parser.parse(value)
            else:
                raise RuntimeError(f"Unknown date type {key}: {value}")
                # try:
                #     obj[key] = datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
                # except:
                #     obj[key] = datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")

    # set the pk
    pk_name, pk_column = get_pk(obj)
    columns[pk_name] = pk_column

    # create ORM class
    the_class = type(name, (sql_base,), columns)
    return the_class(**obj)


def connection_string():
    host = os.environ["db_host"]
    password = os.environ["db_password"]
    user = os.environ["db_user"]

    return f"mysql+pymysql://{user}:{password}@{host}"


def extract_data(type: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    if type in {"push"}:
        return payload

    return payload[type]


ACCEPTABLE_WEBHOOKS = {
    "check_suite",
    "check_run",
    "pull_request",
    "issues",
    "push",
    "create",
    "workflow_job",
}

import sqlalchemy
import re


def fix_tables(session, engine, objects, orm_objects):
    # For each of the objects, ensure the schema in the DB contains that in the
    # orm_objects.
    from sqlalchemy import inspect

    inspector = inspect(engine)

    def column_type_sql(column) -> str:
        return column.type.compile(engine.dialect)

    from sqlalchemy.sql import text

    tables = inspector.get_table_names()
    for orm in orm_objects:
        if orm.__tablename__ not in tables:
            # The ORM will insert the table for us if it's not there
            continue

        sql_columns = inspector.get_columns(orm.__tablename__)
        sql_columns_map = {item["name"]: item for item in sql_columns}
        orm_columns = {k: v for k, v in orm.__dict__.items() if not k.startswith("_")}
        # print(sql_columns_map.keys())
        for new_key in orm_columns:
            if new_key not in sql_columns_map:
                maybe_type = type_map.get(orm.__tablename__, {}).get(new_key, None)
                if maybe_type is not None:
                    continue
                # session.execute()
                data = {
                    "tablename": orm.__tablename__,
                    "colname": new_key,
                }
                breakpoint()
                tablename = sqlalchemy.String('').literal_processor(dialect=engine.dialect)(value=orm.__tablename__)
                colname = sqlalchemy.String('').literal_processor(dialect=engine.dialect)(value=new_key)
                # print(a)
                tablename = tablename.strip("'")
                colname = colname.strip("'")
                # sql_command = text(f"ALTER TABLE `:tablename` ADD COLUMN `:colname` {column_type_sql(orm.__class__.__dict__[new_key])};")
                sql_command = f"alter table `{tablename}` add column `{colname}` {column_type_sql(orm.__class__.__dict__[new_key])}"
                print(f"MISMATCH {orm.__tablename__}.{new_key} DOESNT EXIST")
                print(sql_command)
                with engine.connect() as con:
                    print(sql_command)
                    con.execute(sql_command)
                # session.execute(sql_command)
        # print(orm_columns.keys())
        # break

    for table_name in inspector.get_table_names():
        for column in inspector.get_columns(table_name):

            # print("Column: %s" % column['name'])
            pass

    # exit(0)

async def handle_webhook(payload: Dict[str, Any], type: str):
    global x
    x = ""
    Base = declarative_base()
    print(ACCEPTABLE_WEBHOOKS)
    print(f"[{type}]")
    print(type in ACCEPTABLE_WEBHOOKS)
    if type not in ACCEPTABLE_WEBHOOKS:
        return {"statusCode": 200, "body": f"not processing {type}"}

    # Marshal JSON into SQL-able data
    # data = extract_data(type, payload)
    objects = extract_github_objects(payload, type)
    # NB: This has to be before create_all since it passively registers the tables
    orm_objects = [generate_orm(name, obj, Base) for name, obj in objects]
    # print(flattened_data)
    # exit(0)

    # Set up link to DB
    # engine = create_engine(connection_string(), echo=True)
    engine = create_engine(connection_string(), echo=False)
    Session = sessionmaker(bind=engine)
    Session.configure(bind=engine)
    session = Session()
    Base.metadata.create_all(engine)
    # print(session.execute("show tables"))
    for orm_obj in orm_objects:
        merged = session.merge(orm_obj)
        session.add(merged)

    session.commit()
    # try:
    #     session.commit()
    # except Exception as e:
    #     fix_tables(session, engine, objects, orm_objects)
    #     session.commit()
    #     print("FAILED", e.args[0])
    #     pass
    #     # raise e
    # # print("wrote")

    return {"statusCode": 200, "body": "ok"}


def check_hash(payload, expected):
    signature = hmac.new(
        WEBHOOK_SECRET.encode("utf-8"), payload, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)


def lambda_handler(event, context):
    try:
        print("Invoked")
        expected = event["headers"].get("X-Hub-Signature-256", "").split("=")[1]
        payload = event["body"].encode("utf-8")

        if check_hash(payload, expected):
            body = unquote(event["body"])
            if body.startswith("payload="):
                body = body[len("payload=") :]
            payload = json.loads(body)
            type = event["headers"]["X-GitHub-Event"]

            result = asyncio.run(handle_webhook(payload, type))
        else:
            result = {"statusCode": 403, "body": "Forbidden"}

        print("Result:", result)
    except Exception as ex:
        error = traceback.format_exc()
        return {
            "statusCode": 200,
            "body": x + "\n\n" + repr(ex) + "\n" + error + "\n\n" + event["body"],
        }
    return result


if os.getenv("DEBUG", "") == "1":
    #     def fail():
    #         raise RuntimeError()

    #     connection_string = fail
    from pathlib import Path

    name = Path(sys.argv[1])
    with open(name) as f:
        data = json.load(f)
    print(asyncio.run(handle_webhook(data, type=sys.argv[2])))

