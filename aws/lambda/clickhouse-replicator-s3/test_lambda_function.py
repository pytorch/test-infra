"""Checks on the column list this lambda writes into.

Every adapter that goes through `general_adapter` now NAMES its destination
columns, derived from the same schema string handed to `s3()`. Two ways that
goes wrong, both silent in production — `general_adapter` routes its exception
to `errors.gen_errors` and nothing else reads that table:

  * a derived name that is not a column on the table: every insert for that
    table fails, and the S3 objects are never reprocessed.
  * a parse that walks INTO a nested `Tuple(...)`: inner field names sit at the
    same indentation as real columns, so a line-wise parse silently invents
    columns for oss_ci_benchmark_v3, oss_ci_utilization_metadata and
    cloudwatch_metrics.

Run with `python test_lambda_function.py` (also wired into the deploy
workflow). Importing lambda_function pulls in clickhouse_connect, which is not
needed here, so it is stubbed before import.
"""

import sys
import types
from unittest import mock


sys.modules.setdefault(
    "clickhouse_connect", types.SimpleNamespace(get_client=lambda **kwargs: None)
)

from lambda_function import (  # noqa: E402
    merges_adapter,
    META_COLUMN,
    OBJECT_CONVERTER,
    quote_identifier,
    schema_columns,
)


def test_flat_schema():
    schema = """
    `sha` String,
    `repository` String,
    `timestamp` DateTime64(9)
    """
    assert schema_columns(schema) == ["sha", "repository", "timestamp"]


def test_nested_tuple_fields_are_not_mistaken_for_columns():
    # `metric` is ONE column. Its inner fields are indented exactly like the
    # top-level ones, and `name` collides with a real column name.
    schema = """
    `timestamp` UInt64,
    `name` String,
    `metric` Tuple(
        name String,
        benchmark_values Array(Float32),
        target_value Float32
    ),
    `repo` String
    """
    assert schema_columns(schema) == ["timestamp", "name", "metric", "repo"]


def test_array_of_tuples_is_one_column():
    schema = """
    `job_id` Int64,
    `segments` Array(Tuple(level String, name String, start_at DateTime64(0))),
    `tags` Array(String)
    """
    assert schema_columns(schema) == ["job_id", "segments", "tags"]


def test_unquoted_column_name_is_refused_not_guessed():
    try:
        schema_columns("`ok` String, notquoted String")
    except ValueError:
        return
    raise AssertionError("an unquoted column name must raise, not be guessed")


def test_insert_names_its_columns_including_meta():
    queries = []

    class FakeClient:
        def query(self, q):
            queries.append(q)

    with mock.patch("lambda_function.get_clickhouse_client", lambda: FakeClient()):
        merges_adapter("default.merges", "bkt", "merges/abc.json")

    assert len(queries) == 1, queries
    head = queries[0].strip().splitlines()[0]
    assert head.startswith("insert into default.merges (`_id`, `author`, "), head
    assert head.endswith("`unstable_checks`, `_meta`)"), head


def test_legacy_tables_get_meta_not_underscore_meta():
    # These three predate the `_meta` spelling. A positional insert matched by
    # position and never had to know; a named one does. Asserted as an exact
    # dict and by driving all three adapters — a set-of-values check passes with
    # a key missing or misspelled, which is the whole failure mode.
    assert META_COLUMN == {
        "default.merge_bases": "meta",
        "default.queue_times_historical": "meta",
        "default.rerun_disabled_tests": "meta",
    }, META_COLUMN

    class FakeClient:
        def __init__(self, sink):
            self.sink = sink

        def query(self, q):
            self.sink.append(q)

    for table in META_COLUMN:
        queries = []
        client = FakeClient(queries)
        with mock.patch(
            "lambda_function.get_clickhouse_client", lambda client=client: client
        ):
            OBJECT_CONVERTER[table](table, "bkt", "prefix/abc.json")

        head = queries[0].strip().splitlines()[0]
        assert head.endswith(", `meta`)"), f"{table}: {head}"
        assert "`_meta`" not in head, f"{table}: {head}"


def test_quoting_survives_commas_parens_and_backticks():
    # None of today's schemas need this, but the parser is the thing standing
    # between a schema edit and a silently wrong column list.
    assert schema_columns("`a,b` String, `c` Int64") == ["a,b", "c"]
    assert schema_columns("`x` Enum8('a)' = 1, 'b' = 2), `y` Int64") == ["x", "y"]
    assert schema_columns("`we``ird` String, `z` Int64") == ["we`ird", "z"]
    assert quote_identifier("we`ird") == "`we``ird`"


def test_every_general_adapter_table_names_its_columns():
    """No adapter silently keeps the positional form.

    A `select *` insert still parses and still runs; the only thing that
    notices is the next column added to that table.
    """
    seen = {}

    class FakeClient:
        def __init__(self, table):
            self.table = table

        def query(self, q):
            seen.setdefault(self.table, q)

    positional = []
    for table, adapter in OBJECT_CONVERTER.items():
        client = FakeClient(table)
        with mock.patch(
            "lambda_function.get_clickhouse_client", lambda client=client: client
        ):
            try:
                adapter(table, "bkt", "prefix/abc.json")
            except Exception as e:  # noqa: BLE001 - reported, not swallowed
                raise AssertionError(f"{table} adapter raised: {e}") from e
        query = seen.get(table, "")
        if f"insert into {table} (" not in query:
            positional.append(table)

    # The four bespoke handlers spell their SELECT out column by column instead
    # of going through general_adapter; they are not part of this contract.
    bespoke = {
        "default.test_run_s3",
        "default.failed_test_runs",
        "default.test_run_summary",
        "tests.all_test_runs",
    }
    assert set(positional) == bespoke, (
        f"expected only {sorted(bespoke)} to be positional, got {sorted(positional)}"
    )


if __name__ == "__main__":
    # Discovered, not listed: a hand-maintained list silently stops running the
    # test you add to the file and forget to append here.
    tests = sorted(
        (name, fn)
        for name, fn in list(globals().items())
        if name.startswith("test_") and callable(fn)
    )
    for name, fn in tests:
        fn()
        print(f"ok  {name}")
    print(f"OK ({len(tests)} tests)")
