# Yes this is an adhoc query
import argparse
from pathlib import Path

from torchci.clickhouse import query_clickhouse


REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCHEMA_LOCATION = REPO_ROOT / "clickhouse_db_schema"

# These will need to be updated manually if the schema changes.
EXCLUSIONS = [
    "oss_ci_benchmark_torchinductor_materialized_views",  # materialized view
    "oss_ci_utilization",  # Contains a bunch of tables, doesn't adhere to the expected structure.
    "oss_ci_benchmark_v3_materialized_views",  # materialized view
    "default.all_query_logs",  # special case, should not be updated
    "benchmark.oss_ci_benchmark_v3",  # contains relevant comments, do not want to overwrite
    "README.md",
]


def get_query(table_name: str) -> str:
    """
    Returns the query to get the schema of a ClickHouse table.  Unfortunately,
    we can't use params for this
    """
    return f"show create table {table_name}"


def put_clickhouse_schema(table_name: str) -> None:
    """
    Updates the ClickHouse schema for the specified table.
    This function is used to update the schema file in the repository.
    """
    schema_path = SCHEMA_LOCATION / table_name
    res = query_clickhouse(get_query(table_name), {})
    with open(schema_path / "schema.sql", "w") as f:
        f.write(res[0]["statement"])
        f.write("\n")


def update_current_schemas() -> None:
    # Every folder in clickhouse_db_schemas represents a table in ClickHouse.
    # This function updates the schemas with the current state of the table.
    for schema_path in SCHEMA_LOCATION.iterdir():
        if schema_path.name in EXCLUSIONS:
            print(f"Skipping {schema_path.name} as it is in the exclusion list.")
            continue
        assert schema_path.is_dir(), f"Expected {schema_path} to be a directory"
        table_name = schema_path.name
        put_clickhouse_schema(table_name)


def add_new_schema(table_name: str) -> None:
    schema_path = SCHEMA_LOCATION / table_name
    assert not schema_path.exists(), f"Schema for {table_name} already exists"
    schema_path.mkdir()
    put_clickhouse_schema(table_name)


def arg_parse() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Update ClickHouse database schemas.  By default, updates all schemas."
    )
    parser.add_argument("--add", help="Add a new schema for the specified table")
    return parser.parse_args()


if __name__ == "__main__":
    args = arg_parse()
    if args.add:
        add_new_schema(args.add)
    else:
        update_current_schemas()
    print("Done.")
    print("Please commit the changes to the schema files.")
