"""
This adds a lambda to handle reading / writing to our RDS MySQL instance that we can access from the EC2 runners in CI. Similar to scribe-proxy, this means we can write on pull requests without a secret and also run queries to plan tests / etc.
"""
import json
import datetime
import os
from typing import *
from contextlib import closing
import re


import mysql.connector


_connections = {
    "reader": {
        "connection": None,
        "user": "db_user",
        "password": "db_password",
        "database": "pytorch",
    },
    "inserter": {
        "connection": None,
        "user": "db_user_inserter",
        "password": "db_password_inserter",
        "database": "metrics",
    },
    "creator": {
        "connection": None,
        "user": "db_user_creator",
        "password": "db_password_creator",
        "database": "metrics",
    },
}


def get_connection(name: str):
    field = _connections[name]

    if field["connection"] is None:
        field["connection"] = mysql.connector.connect(
            host=os.environ["db_host"],
            port=3306,
            user=os.environ[field["user"]],
            password=os.environ[field["password"]],
            database=field["database"],
        )

    return field["connection"]


SAVED_QUERIES = {"sample": "select name from workflow_run limit 10"}

TYPE_MAP = {
    "int": "INTEGER",
    "string": "VARCHAR(300)",
}


NAME_REGEX = re.compile("^[a-z_]+$")


def validate_schema_name(s: str):
    if NAME_REGEX.match(s) is not None:
        return s
    else:
        raise RuntimeError(f"Invalid name: {s}")


def safe_join(s: Union[str, List[str]], join_str: str = ", ") -> str:
    if isinstance(s, str):
        s = [s]

    return join_str.join([validate_schema_name(x) for x in s])


def build_query(body):
    # If the request is a simple query we can just build it manually rather
    # than having to hard code it in the list above
    params = []
    table_name = validate_schema_name(body["table_name"])

    query = f"SELECT {safe_join(body['fields'])} FROM {safe_join(table_name)}"

    where = body.get("where", None)
    if where is not None:
        if not isinstance(where, list):
            where = [where]
        for item in where:
            item["field"] = validate_schema_name(item["field"])
        query += " WHERE"
        items = [f"{n['field']} {'like' if n['like'] else '='} %s" for n in where]
        query += f" {' and '.join(items)}"
        params += [n["value"] for n in where]

    group_by = body.get("group_by", None)
    if group_by is not None:
        query += f" GROUP BY {safe_join(group_by)}"

    order_by = body.get("order_by", None)
    if order_by is not None:
        query += f" ORDER BY {safe_join(order_by)}"

    limit = body.get("limit", None)
    if limit is not None:
        query += f" LIMIT %s"
        params.append(int(limit))

    return query, params


def run_query(query: str, params: List[str], connection: Any) -> List[Dict[str, str]]:
    print(f"Executing '{query}' with params: {params}")
    if "--" in query:
        raise RuntimeError("No -- allowed")

    with closing(connection.cursor(dictionary=True)) as cursor:
        cursor.execute(query, params)
        return [row for row in cursor]


def run_write(write):
    # Insert a record into a table
    name = validate_schema_name(write["table_name"])
    fields = {
        validate_schema_name(field): value for field, value in write["values"].items()
    }
    fields["updated_at"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    names = ", ".join([k for k in fields.keys()])

    # Here we can actually use parameterized queries, so don't put the actual
    # values
    placeholders = ", ".join(["%s" for _ in range(len(fields))])
    query = f"INSERT INTO {name}({names}) VALUES ({placeholders})"
    params = [v for v in fields.values()]

    conn = get_connection("inserter")
    res = run_query(query, params, conn)
    conn.commit()
    return res


def run_create_table(create_table):
    name = validate_schema_name(create_table["table_name"])

    def mquery(sql):
        return run_query(sql, [], get_connection("creator"))

    # Validate all the field names since we have to insert them directly
    fields = {
        validate_schema_name(field): TYPE_MAP[validate_schema_name(type)]
        for field, type in create_table["fields"].items()
    }
    # Add a marker of when this data was inserted
    fields["updated_at"] = "DATETIME"

    if "id" in fields:
        raise RuntimeError(f"Cannot use name 'id': {fields}")

    # SQL returns schema types a little different from how they're specified, so
    # fix that up here
    def clean_type(s):
        if s == "int(11)":
            return "integer".upper()
        return s.upper()

    try:
        # Check if the table exists
        schema = mquery(f"DESCRIBE {name}")
        existing_fields = {x["Field"]: x["Type"] for x in schema}
        existing_fields = {
            field: clean_type(type) for field, type in existing_fields.items()
        }

        # Make sure every requested field in the DB is there and the type
        # matches, and fix it if not
        for field, type in fields.items():
            if field not in existing_fields:
                print(f"Adding new field {field}")
                mquery(f"ALTER TABLE {name} ADD COLUMN {field} {type}")
            elif existing_fields[field] != type:
                print(f"Modifying {field}")
                mquery(f"ALTER TABLE {name} MODIFY {field} {type}")

    except mysql.connector.errors.ProgrammingError as e:
        if not str(e).endswith(f"Table 'metrics.{name}' doesn't exist"):
            raise e

        # The table isn't there at all and we need to create it from scratch
        field_queries = [f"{field} {type}" for field, type in fields.items()]
        create_table_query = f"""
            CREATE TABLE {name} (
                id INTEGER AUTO_INCREMENT,
                {', '.join(field_queries)},
                PRIMARY KEY (id)
            );
        """.strip()
        print(create_table_query)
        mquery(create_table_query)


def run_read(read):
    # If the query is in the list of hardcoded queries, just use that
    print(f"Executing read {read}")
    saved_query_name = read.get("saved_query_name", None)
    params = read.get("params", [])
    saved_query = SAVED_QUERIES.get(saved_query_name, None)
    if saved_query is not None:
        results = run_query(saved_query, params, get_connection("reader"))
    else:
        # Build a SQL query ad-hoc and run it
        query, params = build_query(read)
        results = run_query(query, params, get_connection("reader"))

    print("Fetched", results)
    return json.dumps(results, default=str)


def handle_event(event):
    print("Handling event", event)
    create_table = event.get("create_table", None)
    if create_table is not None:
        # Create the table if requests, gated behind a killswitch since we
        # shouldn't need this to be on all the time
        if os.environ.get("create_enabled", False) == "1":
            return run_create_table(create_table)
        else:
            return "create is disabled"

    write = event.get("write", None)
    if write is not None:
        return run_write(write)

    read = event.get("read", None)
    if read is not None:
        return run_read(read)


def lambda_handler(events, context):
    """
    Takes in a list of "events", which are actions for the lambda to do on MySQL

    Create: make a table or alter an existing table
        {
            "create_table": {
                "table_name": "my_table",
                "fields": {
                    "something": "int",
                    "something_else": "string",
                },
            }
        }

    Write: insert a record into a metrics table
        {
            "create_table": {
                "table_name": "my_table",
                "fields": {
                    "something": "int",
                    "something_else": "string",
                },
            }
        }

    Read: query the pytorch database (everything after "fields" is optional)
        {
            "read": {
                "table_name": "my_table",
                "fields": ["something", "something_else"],
                "where": [
                    {
                        "field": "something",
                        "value": 10
                    }
                ],
                "group_by": ["something"],
                "order_by": ["something"],
                "limit": 5,
            }
        }

        or use a hardcoded query

        {
            "read": {
                "saved_query_name": "sample",
            }
        }
    """
    print("Handling", events)

    # Run over all the requests and collate the results
    results = []
    for event in events:
        results.append(handle_event(event))

    print(results)
    return results
