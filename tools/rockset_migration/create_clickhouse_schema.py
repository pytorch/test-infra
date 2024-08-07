from collections import defaultdict
import json
import re
from typing import Dict, List
import rockset
from rockset_queries import get_query_lambdas
from torchci.rockset_utils import query_rockset


def get_rockset_schema(table_name: str, allow_nullable=False):
    """
    Query the Rockset API to get the schema of a table.  Returns a dictionary of the form
    field: type
    where field is formatted as a dot-separated string of the field names if it is a nested field.
    For example:
    {
        "name": "string",
        "actor.id": "int"
    }

    """
    schema = query_rockset(f"describe {table_name}")
    schema_as_dict = defaultdict(list)
    for row in schema:
        if not allow_nullable and row["type"] == "null":
            continue
        fields = row["field"]
        if len(fields) == 1:
            schema_as_dict[fields[0]].append(row["type"])
        else:
            name = ".".join(fields)
            schema_as_dict[name].append(row["type"])
    return schema_as_dict


def get_table_field_usages(table_name: str):
    lambdas = get_query_lambdas()
    fields = set()
    for lambda_name, lambda_info in lambdas.items():
        try:
            if lambda_name in [
                "commons.flaky_test_history",
                "commons.flaky_tests_per_job",
                "commons.original_pr_hud_query",
            ]:
                continue
            sql = lambda_info.sql["query"]
            params = {}
            for param in lambda_info.sql["default_parameters"]:
                typee = param["type"]
                val = param["value"]
                name = param["name"]
                if typee == "int":
                    val = int(val)
                params[name] = val
            if len(params) == 0:
                params = None
            if table_name in sql:
                explain = query_rockset(f"explain {sql}", params=params)[0]["EXPLAIN"]
                for line in explain.split("\n"):
                    if f"{table_name}:" not in line:
                        continue
                    field_match = re.findall(r"=([\w\.]+)", line)
                    for f in field_match:
                        fields.add(f)
        except Exception as e:
            print(e)
            print(lambda_name)
            print(sql)
            print(params)
            print(table_name)
            raise e

    # Remove all _event_time fields
    fields = {f for f in fields if not f.endswith("_event_time")}
    return fields


def get_types_for_fields(schema_as_dict, fields):
    fields_with_types = {}
    for field in sorted(fields):
        fields_with_types[field] = schema_as_dict.get(
            field, ["doesn't exist in schema?"]
        )
    return fields_with_types


def get_types_for_used_fields(schema_as_dict, used_fields):
    return get_types_for_fields(schema_as_dict, used_fields)


def get_types_for_unused_fields(schema_as_dict, used_fields):
    unused_fields = set(schema_as_dict.keys()) - set(used_fields)
    return get_types_for_fields(schema_as_dict, unused_fields)


def gen_schema(fields: Dict[str, str]) -> List[str]:
    schema = {}


    def get_type(types: List[str]) -> str:
        rockset_type_to_clickhouse_type_map = {
            "string": "String",
            "int": "Int64",
            "object": "Tuple",
            "array": "Array",
        }
        nullable = "null" in types
        if nullable:
            types.remove("null")
        if len(types) > 1:
            return f"InvalidType {types}"
        typee = types[0]
        if typee in rockset_type_to_clickhouse_type_map:
            clickhouse_type = rockset_type_to_clickhouse_type_map[typee]
            if nullable:
                return f"Nullable({clickhouse_type})"
            return clickhouse_type
        return f"InvalidType {typee}"

    for field, typee in fields.items():
        # field = field.replace(".", "_")
        schema[field] = get_type(typee)
    schema_strings: List[str] = []
    for field, typee in schema.items():
        schema_strings.append(f"`{field}` {typee}")
    return schema_strings


def gen_schema_with_create_table(table_name: str, schema: List[str]):
    s = f"CREATE TABLE {table_name}\n(\n"
    for line in schema:
        if line:
            s += f"  {line},\n"
        else:
            s += "\n"
    s += ")\nENGINE = ReplacingMergeTree()\nPRIMARY KEY id\nORDER BY id\n"
    s += "\n\n"
    s += "Notes:\n"
    s += (
        "  Fill in types as best as possible.  If the script cannot infer the type, it is marked as InvalidType\n"
        "  The syntax for tuples (objects) is 'Tuple(field1_name field1_type, field2_name field2_type, ...)'\n"
        "    Attempt to unnest these when possible\n"
        "    Fields in the object/tuple have the name 'object_name.field_name'\n"
        "  The syntax for arrays is 'Array(field_type)'\n"
        "    Arrays usually get typed as 'Array'\n"
        "    To determine the type of object in the array, look for the field named 'array_name.*'\n"
        "  Attempt to avoid nullables when possible, but if needed nullable types should take on the form 'Nullable(field_type)'\n"
        "  The emtpy line indicates the separation between fields that are used and fields that are unused\n"
        "    This may be inaccurate, especially for nested fields\n"
        "  Do your best to remove fields that are unusued\n"
        "  Fields like '_event_time', '_id', and '_meta' should be removed\n"
        "  'DateTime64(9)' can be used for dates.  These fields are generally named 'something_at'\n"
        "  Syntax requires that the last item not be followed by a comma"
    )
    return s


def parse_args():
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("table_name", type=str, help="The name of the table in Rockset")
    parser.add_argument(
        "--allow-nullable", action="store_true", help="Allow nullable fields"
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    table_name = args.table_name
    used_fields = get_table_field_usages(table_name)
    schema_as_dict = get_rockset_schema(table_name, allow_nullable=args.allow_nullable)

    used_fields_with_types = get_types_for_used_fields(schema_as_dict, used_fields)
    unused_fields_with_types = get_types_for_unused_fields(schema_as_dict, used_fields)

    used_fields_schema = gen_schema(used_fields_with_types)
    unused_fields_schema = gen_schema(unused_fields_with_types)

    final_schema = gen_schema_with_create_table(
        table_name, used_fields_schema + [""] + unused_fields_schema
    )
    print(final_schema)
