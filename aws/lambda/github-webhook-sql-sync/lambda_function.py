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
import sqlalchemy
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

# This marks that a key would store an object (something with a node_id)
OBJECT_PLACEHOLDER = object()

NAME_MAP = {
    "id": (str, lambda: Column(String(20))),
}

TYPE_MAP = {
    "repository": {
        "description": lambda: Column(String(300)),
        "homepage": lambda: Column(String(300)),
        "license": lambda: OBJECT_PLACEHOLDER,
        "mirror_url": lambda: Column(String(300)),
        "master_branch": lambda: Column(String(300)),
        "stargazers": lambda: Column(Integer),
        "organization": lambda: Column(String(300)),
    },
    "issues_event": {
        "changes_title_from": lambda: Column(String(300)),
        "changes_body_from": lambda: Column(Text),
        "label": lambda: OBJECT_PLACEHOLDER,
    },
    "push_event": {
        "base_ref": lambda: Column(String(300)),
        "head_commit_message": lambda: Column(Text),
    },
    "license": {
        "url": lambda: Column(String(300)),
    },
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
    "enterprise": {
        "description": lambda: Column(Text),
        "website_url": lambda: Column(String(300)),
    },
    "check_run": {
        "name": lambda: Column(String(300)),
        "conclusion": lambda: Column(String(100)),
        "output_title": lambda: Column(String(100)),
        "output_summary": lambda: Column(Text),
        "output_text": lambda: Column(Text),
    },
    "workflow_job": {"conclusion": lambda: Column(String(100)),},
    "create_event": {"description": lambda: Column(String(100)),},
    "check_suite": {
        "conclusion": lambda: Column(String(100)),
        "latest_check_runs_count": lambda: Column(Integer),
        "before": lambda: Column(String(300)),
        "after": lambda: Column(String(300)),
    },
    "commit": {
        "commit_verification_signature": lambda: Column(String(300)),
        "commit_verification_payload": lambda: Column(String(300)),
        "author": lambda: OBJECT_PLACEHOLDER,
        "committer": lambda: OBJECT_PLACEHOLDER,
    },
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


ACCEPTABLE_WEBHOOKS = {
    "check_suite",
    "check_run",
    "pull_request",
    "issues",
    "push",
    "create",
    "workflow_job",
    "status",
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

    # Add an entry for the top level object
    objects.append((f"{obj_name}_event", flatten_object(obj)))

    # Add the time of creation for each object
    for _, object in objects:
        object["sync_last_update_at"] = datetime.datetime.now()

    return objects


def get_column(key: str, value: Any, type_name: str) -> Column:
    """
    If the key is present for the webhook type 'type_name' in the hardcoded
    TYPE_MAP, use it. Otherwise, guess the type based on the value's runtime
    type.
    """
    if key in TYPE_MAP.get(type_name, {}):
        return TYPE_MAP[type_name][key]()

    if key in NAME_MAP:
        return NAME_MAP[key][1]()

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
        # Don't error out immediately, but bubble this up so we can report all
        # errors at once later
        return None


rprint_buffer = ""


def rprint(s):
    global rprint_buffer
    rprint_buffer += "\n" + str(s)


def is_date(key: str, value: Any) -> bool:
    return key.endswith("_at") or key.endswith("timestamp")


def get_primary_key(obj: FlatDict) -> Tuple[str, Column]:
    if "node_id" in obj:
        return "node_id", Column(String(50), primary_key=True)

    return "pk_id", Column(Integer, primary_key=True)


def transform_data(obj: Dict[str, Any]) -> Dict[str, Any]:
    """
    Run in-place transformations on obj to translate fields into the appropriate
    type for storage:
        * lists -> JSON encoded data
        * dates -> Python datetimes
    """
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
        elif isinstance(value, str):
            # TODO: Use utf8mb4 on the DB instead of this which deletes all
            # unicode chars
            obj[key] = value.encode("ascii", "ignore").decode()

    for key, item in NAME_MAP.items():
        caster, _ = item
        if key in obj:
            obj[key] = caster(obj[key])

    return obj


def generate_orm(name: str, obj: FlatDict, sql_base: Any) -> Any:
    """
    Create an instance of a SQLAlchemy ORM class from a dictionary.
    """
    columns = {"__tablename__": name, "__table_args__": {"extend_existing": True}}
    errors = []
    for key, value in obj.items():
        col = get_column(key, value, type_name=name)
        if col is OBJECT_PLACEHOLDER:
            # There is a null object (with a node_id) missing, so create it as
            # we would if something was there but leave the value blank
            columns[f"{key}_node_id"] = Column(String(50))
        elif col is None:
            # Unable to find a type for this value. An entry is missing in the
            # TYPE_MAP for this name.key pair
            errors.append(f"{name}.{key}: {value}")
        else:
            # Got a column successfully, so set it on the table
            columns[key] = col

    if len(errors) > 0:
        # Couldn't get a column type for some of the data, so error out
        catted_errors = "\n    ".join([f"typeerr: {e}" for e in errors])
        raise RuntimeError(f"Unknown types:\n{catted_errors}")

    # Change data into the right types for storage
    obj = transform_data(obj)

    # Fill in any inconsistent / missing columns from the GitHub API
    # The loop above only looks at the data actually received on the webhook.
    # Some things may be missing (inconsistencies in GitHub's API or just
    # doesn't exist), so fill in their types here:
    for key, column_creator in TYPE_MAP.get(name, {}).items():
        value = column_creator()
        if value is OBJECT_PLACEHOLDER:
            columns[f"{key}_node_id"] = Column(String(50))
            if key in obj:
                if obj[key] is not None:
                    raise RuntimeError(f"not doing it {name}.{key}")
                else:
                    del obj[key]
                    obj[f"{key}_node_id"] = None
        else:
            columns[key] = value

    # Set the primary key (some webhooks don't have a node_id at the top level
    # so set up an auto-incrementing int ID for them)
    pk_name, pk_type = get_primary_key(obj)
    columns[pk_name] = pk_type

    # Create SQLAlchemy ORM class (which registers it to be created in sql_base)
    the_class = type(name, (sql_base,), columns)
    return the_class(**obj)


def connection_string():
    host = os.environ["db_host"]
    password = os.environ["db_password"]
    user = os.environ["db_user"]

    return f"mysql+pymysql://{user}:{password}@{host}?charset=utf8mb4"


async def handle_webhook(payload: Dict[str, Any], type: str):
    global rprint_buffer
    rprint_buffer = ""
    Base = declarative_base()

    # Only look at allowlisted webhooks
    if type not in ACCEPTABLE_WEBHOOKS:
        return {"statusCode": 200, "body": f"not processing {type}"}

    # Marshal JSON into SQL-able data
    objects = extract_github_objects(payload, type)

    # NB: This has to be before create_all since it passively registers the tables
    orm_objects = [generate_orm(name, obj, Base) for name, obj in objects]

    # Set up link to DB
    engine = create_engine(connection_string(), echo=bool(os.getenv("ECHO", False)))
    Session = sessionmaker(bind=engine)
    Session.configure(bind=engine)
    session = Session()
    Base.metadata.create_all(engine)

    # Set all the objects on the session
    for orm_obj in orm_objects:
        merged = session.merge(orm_obj)
        session.add(merged)

    # Write to DB
    session.commit()

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
    s3 = session.resource('s3')

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

            save_to_s3(event_type, payload)

            result = asyncio.run(handle_webhook(payload, event_type))
        else:
            result = {"statusCode": 403, "body": "Forbidden"}

        print("Result:", result)
    except Exception as ex:
        error = traceback.format_exc()
        return {
            "statusCode": 500,
            "body": rprint_buffer
            + "\n\n"
            + repr(ex)
            + "\n"
            + error
            + "\n\n"
            + event["body"],
        }
    return result


if os.getenv("DEBUG", "") == "1":
    from pathlib import Path

    name = Path(sys.argv[1])
    with open(name) as f:
        data = json.load(f)
    print(asyncio.run(handle_webhook(data, type=sys.argv[2])))

