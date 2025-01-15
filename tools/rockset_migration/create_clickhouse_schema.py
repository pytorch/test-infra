"""
Use this to generate a Clickhouse schema from a Rockset table. It still requires
some manual work to verify and fill in some types if the script cannot infer
them.
"""

import re
from typing import Dict, List

from rockset_queries import get_query_lambdas
from torchci.rockset_utils import query_rockset


class Field:
    full_name: List[str]
    type: List[str]
    used: bool = False
    nullable: bool = False
    nested_fields: Dict[str, "Field"]

    def short_name(self):
        return ".".join(self.full_name)

    def __init__(self, full_name: List[str]):
        self.full_name = full_name
        self.type = []
        self.nested_fields = {}

    def __str__(self):
        return f"{self.short_name()} {self.type} {self.nullable} {self.used} {self.nested_fields}"

    def __repr__(self):
        return str(self)

    def get_clickhouse_type(self, allow_nullable=False):
        rockset_type_to_clickhouse_type_map = {
            "string": "String",
            "int": "Int64",
            "object": "Tuple",
            "array": "Array",
            "bool": "Bool",
            "datetime": "DateTime64(9)",
            "float": "Float32",
        }
        if len(self.type) == 0:
            return "InvalidType"
        types = []
        for type in self.type:
            clickhouse_type = rockset_type_to_clickhouse_type_map.get(type)
            if clickhouse_type is None:
                clickhouse_type = f"InvalidType {type}"
            elif clickhouse_type == "Array":
                if "*" not in self.nested_fields:
                    clickhouse_type = "Array(InvalidType cannot find * nested field)"
                else:
                    clickhouse_type = (
                        f"Array({self.nested_fields['*'].get_clickhouse_type()})"
                    )
            elif clickhouse_type == "Tuple":
                children_types = ", ".join(
                    [
                        f"{f.full_name[-1]} {f.get_clickhouse_type()}"
                        for f in self.nested_fields.values()
                    ]
                )
                clickhouse_type = f"Tuple({children_types})"
            types.append(clickhouse_type)
        if len(types) > 1:
            final_type = f"Variant({', '.join(types)})"
        else:
            final_type = types[0]
        if self.nullable and allow_nullable:
            return f"Nullable({final_type})"
        return final_type


def get_rockset_schema(table_name: str, allow_nullable=False):
    """
    Query the Rockset API to get the schema of a table.  Returns a dictionary of the form
    field: type
    where field is formatted as a dot-separated string of the field names if it is a nested field.
    For example:
    {
        "name": ["string"],
        "actor.id": ["int"],
    }

    """
    schema = query_rockset(f"describe {table_name}")
    schema_as_dict = {}
    for row in schema:
        field = Field(row["field"])
        if field.short_name() in schema_as_dict:
            field = schema_as_dict[field.short_name()]
        else:
            schema_as_dict[field.short_name()] = field

        if row["type"] == "null":
            field.nullable = True
        else:
            field.type.append(row["type"])

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


def nest_fields(schema_as_dict: Dict[str, Field]):
    nested: Dict[str, Field] = {}
    for field in schema_as_dict.values():
        if len(field.full_name) == 1:
            nested[field.full_name[0]] = field
        else:
            curr = nested
            for i, parent in enumerate(field.full_name[:-1]):
                if parent not in curr:
                    curr[parent] = Field(field.full_name[: i + 1])
                    curr[parent].type.append("object")
                curr = curr[parent].nested_fields
            curr[field.full_name[-1]] = field
    return nested


def gen_schema(fields: Dict[str, Field], allow_nullable=False):
    schema = []
    for field in fields.values():
        schema.append(
            f"`{field.short_name()}` {field.get_clickhouse_type(allow_nullable)}"
        )
    return ",\n".join(schema)


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
    schema_as_dict = get_rockset_schema(table_name)

    nested_fields = nest_fields(schema_as_dict)
    print(gen_schema(nested_fields, args.allow_nullable))
