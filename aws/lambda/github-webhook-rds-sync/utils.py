import json
import sys
import pymysql
import datetime
import traceback
import asyncio
import os
import hmac
import hashlib
import sqlalchemy
from typing import *
from urllib.parse import unquote


from sqlalchemy import create_engine, schema
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

# We're just going to dump the webhook straight into mysql by flattening out the
# JSON object and inlining arrays into JSON strings
FlatDict = Dict[str, Union[str, int]]
NamedDict = Tuple[str, FlatDict]


WEBHOOK_SECRET = os.environ["gh_secret"]

# This marks that a key would store an object (something with a node_id)
OBJECT_PLACEHOLDER = object()

NAME_MAP = {
    "id": (str, lambda: Column(String(20))),
}

TYPE_MAP = {
    "repository": {
        "description": lambda: Column(Text),
        "homepage": lambda: Column(String(300)),
        "license": lambda: OBJECT_PLACEHOLDER,
        "mirror_url": lambda: Column(String(300)),
        "master_branch": lambda: Column(String(300)),
        "stargazers": lambda: Column(Integer),
        "organization": lambda: Column(String(300)),
        "allow_squash_merge": lambda: Column(Boolean),
        "allow_merge_commit": lambda: Column(Boolean),
        "allow_rebase_merge": lambda: Column(Boolean),
        "allow_auto_merge": lambda: Column(Boolean),
        "delete_branch_on_merge": lambda: Column(Boolean),
    },
    "app": {
        "description": lambda: Column(Text),
    },
    "issues_event": {
        "changes_title_from": lambda: Column(String(300)),
        "changes_body_from": lambda: Column(Text),
        "label": lambda: OBJECT_PLACEHOLDER,
        "milestone": lambda: OBJECT_PLACEHOLDER,
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
        "body": lambda: Column(Text),
        "active_lock_reason": lambda: Column(String(100)),
        "performed_via_github_app": lambda: Column(Boolean),
    },
    "user": {
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
        "output_title": lambda: Column(String(300)),
        "output_summary": lambda: Column(Text),
        "output_text": lambda: Column(Text),
    },
    "workflow_job": {
        "conclusion": lambda: Column(String(100)),
    },
    "create_event": {
        "description": lambda: Column(String(100)),
    },
    "label": {"description": lambda: Column(Text)},
    "review": {
        "body": lambda: Column(Text),
    },
    "pull_request_review_event": {
        "changes_body_from": lambda: Column(Text),
    },
    "pull_request_review_comment_event": {
        "changes_body_from": lambda: Column(Text),
    },
    "comment": {
        "performed_via_github_app": lambda: OBJECT_PLACEHOLDER,
        "body": lambda: Column(Text),
        "side": lambda: Column(String(30)),
        "start_side": lambda: Column(String(30)),
        "diff_hunk": lambda: Column(Text),
        "pull_request_review_id": lambda: Column(String(20)),
        "original_start_line": lambda: Column(Integer),
        "path": lambda: Column(String(300)),
        "start_line": lambda: Column(Integer),
        "position": lambda: Column(Integer),
        "original_position": lambda: Column(Integer),
        "line": lambda: Column(Integer),
        "original_line": lambda: Column(Integer),
        "commit_id": lambda: Column(String(300)),
        "original_commit_id": lambda: Column(String(300)),
        "in_reply_to_id": lambda: Column(String(30)),
    },
    "issue_comment_event": {"changes_body_from": lambda: Column(Text)},
    "check_suite": {
        "conclusion": lambda: Column(String(100)),
        "latest_check_runs_count": lambda: Column(Integer),
        "before": lambda: Column(String(300)),
        "after": lambda: Column(String(300)),
        "head_branch": lambda: Column(String(300)),
        "head_commit_message": lambda: Column(Text),
        "head_commit_id": lambda: Column(String(300)),
        "head_commit_tree_id": lambda: Column(String(300)),
        "head_commit_timestamp": lambda: Column(DateTime),
        "head_commit_author_name": lambda: Column(String(300)),
        "head_commit_author_email": lambda: Column(String(300)),
        "head_commit_committer_name": lambda: Column(String(300)),
        "head_commit_committer_email": lambda: Column(String(300)),
    },
    "commit": {
        "commit_verification_signature": lambda: Column(Text),
        "commit_verification_payload": lambda: Column(Text),
        "author": lambda: OBJECT_PLACEHOLDER,
        "committer": lambda: OBJECT_PLACEHOLDER,
        "commit_message": lambda: Column(Text),
    },
    "milestone": {
        "due_on": lambda: Column(DateTime),
    },
    "installation_event": {
        "installation_single_file_name": lambda: Column(Text),
        "installation_suspended_by": lambda: OBJECT_PLACEHOLDER,
        "requester": lambda: OBJECT_PLACEHOLDER,
    },
    "pull_request": {
        "body": lambda: Column(Text),
        "comments": lambda: Column(Integer),
        "commits": lambda: Column(Integer),
        "deletions": lambda: Column(Integer),
        "changed_files": lambda: Column(Integer),
        "additions": lambda: Column(Integer),
        "review_comments": lambda: Column(Integer),
        "milestone": lambda: OBJECT_PLACEHOLDER,
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
        "merged": lambda: Column(Boolean),
        "mergeable": lambda: Column(Boolean),
        "maintainer_can_modify": lambda: Column(Boolean),
        "mergeable_state": lambda: Column(String(100)),
        "rebaseable": lambda: Column(Boolean),
        "merged_by": lambda: Column(String(100)),
        "merge_commit_sha": lambda: Column(String(100)),
        "assignee": lambda: OBJECT_PLACEHOLDER,
    },
    "pull_request_event": {
        "changes_title_from": lambda: Column(String(300)),
        "changes_body_from": lambda: Column(Text),
    },
    "workflow_run": {
        "id": lambda: Column(String(20)),
        "check_suite_id": lambda: Column(String(20)),
        "workflow_id": lambda: Column(String(20)),
        "head_commit_message": lambda: Column(Text),
    }
}

TABLE_NAME_REMAP = {
    "head_repository": "repository",
    "repo": "repository",
    "committer": "user",
    "assignee": "user",
    "author": "user",
    "requested_reviewer": "user",
    "owner": "user",
    "requester": "user",
    "installation_suspended_by": "user",
    "sender": "user",
    "account": "user",
    "creator": "user",
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
            full_name = "_".join(name + [key])
            if value is None or isinstance(value, (str, int, bool, list)):
                result[full_name] = value
            elif isinstance(value, dict):
                helper(value, name + [key])
            else:
                raise RuntimeError(f"Unknown type on {full_name}: {value}")

    helper(obj, [])
    return result


def extract_github_objects(obj: Dict[str, Any], obj_name: str) -> List[NamedDict]:
    """
    GitHub's real 'objects' (i.e. things accessible in the API) all have a
    unique "node_id" string. This descends into an object and pulls out anything
    with a node_id and removes it from the parent. It also flattens the objects
    from a Dict[str, Any] to a Dict[str, str] (with an exception for lists so we
    still know later on that they're lists and not ordinary strings)
    """
    objects = []

    def drop_key(key: str) -> bool:
        return (
            key.endswith("_url")
            or key == "_links"
            or key == "url"
            or key == "permissions"
        )

    def visit_dict(curr: Dict[str, Any], full_name: List[str]) -> Tuple[bool, FlatDict]:
        result = {}

        for key, value in list(curr.items()):
            # Objects are not always named consistently (e.g. repository vs
            # repo, owner vs. user, so fix that up here)
            remapped_key = TABLE_NAME_REMAP.get(key, None)

            if drop_key(key):
                # Ignore URLs
                continue

            if isinstance(value, dict):
                if remapped_key is not None:
                    is_gh_object, data = visit_dict(value, full_name + [remapped_key])
                else:
                    is_gh_object, data = visit_dict(value, full_name + [key])

                if not is_gh_object:
                    # Not a separate object so inline all of its fields
                    for flat_key, flat_value in flatten_object(data).items():
                        result[f"{key}_{flat_key}"] = flat_value
                else:
                    # It will go into its own table so just put a link to it
                    # here
                    result[f"{key}_node_id"] = data["node_id"]
            elif (
                value is None
                and TYPE_MAP.get(full_name[-1], {}).get(key, lambda: None)()
                == OBJECT_PLACEHOLDER
            ):
                # We might have a null object, in which case we still need to
                # add it as a _node_id
                result[f"{key}_node_id"] = None
            else:
                result[key] = value

        if "node_id" in curr:
            # It's a github object so stash it for returning later
            objects.append((full_name[-1], result))
            return True, curr
        else:
            return False, result

    _, newobj = visit_dict(obj, [obj_name])

    # Add an entry for the top level object
    objects.append((f"{obj_name}_event", flatten_object(newobj)))

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
    if isinstance(value, dict):
        raise RuntimeError(f"Value cannot be a dict: {key}: {value}")

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
        # breakpoint()
        if key.endswith("_node_id"):
            return get_column(key[: -len("_node_id")], value, type_name)
        # raise RuntimeError()
        return None


rprint_buffer = ""


def rprint(s):
    global rprint_buffer
    rprint_buffer += "\n" + str(s)


def is_date(key: str, value: Any) -> bool:
    return key.endswith("_at") or key.endswith("timestamp")


def get_primary_key(name: str, obj: FlatDict) -> Tuple[str, Column]:
    if "node_id" in obj:
        # if name == "status_event":
        #     return "node_id", Column(String(100), primary_key=True)
        return "node_id", Column(String(100), primary_key=True)

    return "pk_id", Column(Integer, primary_key=True)


def transform_data(obj: Dict[str, Any]) -> Dict[str, Any]:
    """
    Run in-place transformations on obj to translate fields into the appropriate
    type for storage:
        * lists -> JSON encoded data
        * dates -> Python datetimes
    """
    for key, value in obj.items():
        if value is None:
            # Don't bother writing nulls, they can mess with object fields
            continue
        if isinstance(value, list):
            obj[key] = json.dumps(value)
        elif is_date(key, value) and value is not None:
            if isinstance(value, int):
                # convert from timestamp
                obj[key] = datetime.datetime.fromtimestamp(value)
            elif isinstance(value, datetime.datetime):
                obj[key] = value
            elif isinstance(value, str):
                formats = ["%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%S.%f%z"]
                date = None

                for format in formats:
                    try:
                        date = datetime.datetime.strptime(value, format)
                    except ValueError:
                        pass

                if date is None:
                    raise RuntimeError(value)
                obj[key] = date
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
            columns[f"{key}_node_id"] = Column(String(100))
        elif col is None:
            # Unable to find a type for this value. An entry is missing in the
            # TYPE_MAP for this name.key pair
            errors.append(f"{name} -> {key}: {value}")
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
    pk_name, pk_type = get_primary_key(name, obj)
    columns[pk_name] = pk_type

    # Create SQLAlchemy ORM class (which registers it to be created in sql_base)
    the_class = type(name, (sql_base,), columns)
    return the_class(**obj)


def connection_string():
    host = os.environ["db_host"]
    password = os.environ["db_password"]
    user = os.environ["db_user"]

    return f"mysql+pymysql://{user}:{password}@{host}?charset=utf8mb4"


engine = None


def get_engine(connection_string: str):
    global engine
    if engine is None:
        engine = create_engine(connection_string, echo=bool(os.getenv("ECHO", False)))

    return engine
