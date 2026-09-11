"""Checks on the one insert in the S3 replicator that names its target columns.

`general_adapter` inserts positionally by default. `merges_adapter` opts out by
passing `columns`, so `ai_not_related_checks` can be ALTERed into
`default.merges` before the schema string declares it.

`MERGES_COLUMNS` is derived from `MERGES_SCHEMA`, so the risk that buys is a
derivation bug: a name that is not a column on the table would fail every merge
insert silently -- `general_adapter` routes the exception to `errors.gen_errors`
and nothing reads that table -- and a wrong ORDER would not fail at all, it
would write into the wrong column. Hence `EXPECTED_MERGES_COLUMNS` below, which
states the answer independently instead of recomputing it.

Lives here rather than beside the lambda so the existing "Test aws lambda" job
in tests.yml picks it up on every pull request. The lambda's own directory name
is hyphenated and so cannot be imported as a package; hence the path load below.
"""

import ast
import importlib.util
import pathlib
import re
import sys
import types
from unittest import mock

import pytest


LAMBDA_DIR = pathlib.Path(__file__).resolve().parents[1] / "clickhouse-replicator-s3"

try:  # pragma: no cover - present in CI via test_requirements.txt
    import clickhouse_connect  # noqa: F401
except ImportError:
    # Only stub when the real package is absent, so this file can run outside
    # CI without shadowing the module other tests in the session may need.
    sys.modules["clickhouse_connect"] = types.SimpleNamespace(
        get_client=lambda **kwargs: None
    )


def _load():
    spec = importlib.util.spec_from_file_location(
        "clickhouse_replicator_s3_lambda", LAMBDA_DIR / "lambda_function.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


lambda_function = _load()


def captured_query(call, *args, **kwargs):
    """Run an adapter with the ClickHouse client stubbed; return the SQL it sent."""
    queries = []
    client = mock.Mock()
    client.query.side_effect = lambda sql: queries.append(sql)
    with mock.patch.object(lambda_function, "get_clickhouse_client", lambda: client):
        call(*args, **kwargs)
    assert len(queries) == 1, f"expected one query, got {len(queries)}"
    return queries[0]


# The insert projection merges_adapter is expected to write: the destination
# names, in the order its SELECT produces them. Written out on purpose --
# MERGES_COLUMNS is derived from MERGES_SCHEMA, so without an independent
# statement of the answer the derivation would only be compared against itself.
# Each name was confirmed to be a column of default.merges against
# system.columns on 2026-09-10; it is NOT a snapshot of the whole table, and
# after `ai_not_related_checks` is ALTERed in it deliberately will not name it.
# What has to hold is that these agree with the SELECT's expressions, so a
# wrong ORDER is the dangerous failure: several of these share a type, and
# mismatched names would write into the wrong column without failing.
EXPECTED_MERGES_COLUMNS = [
    "`_id`",
    "`author`",
    "`broken_trunk_checks`",
    "`comment_id`",
    "`dry_run`",
    "`error`",
    "`failed_checks`",
    "`flaky_checks`",
    "`ignore_current`",
    "`ignore_current_checks`",
    "`is_failed`",
    "`last_commit_sha`",
    "`merge_base_sha`",
    "`merge_commit_sha`",
    "`owner`",
    "`pending_checks`",
    "`pr_num`",
    "`project`",
    "`skip_mandatory_checks`",
    "`unstable_checks`",
    "`_meta`",
]


def test_derived_columns_are_the_columns_the_table_has():
    assert lambda_function.MERGES_COLUMNS == EXPECTED_MERGES_COLUMNS


def test_every_name_is_backtick_quoted():
    # An unquoted name would still be valid SQL for most of these, but `error`
    # is close enough to reserved that quoting is not optional by inspection --
    # so require it of all of them.
    for name in lambda_function.MERGES_COLUMNS:
        assert re.fullmatch(r"`[^`]+`", name), name


def test_a_nested_tuple_is_refused_rather_than_miscounted():
    # The real shape this guards: handle_test_run_s3's `properties` field. A
    # line-wise scan would return `properties`, `property`, `name` and `value`
    # as four columns where `select *` produces one expression.
    with pytest.raises(ValueError, match="not flat"):
        lambda_function.flat_schema_columns(
            """
            `job_id` Int64,
            `properties` Tuple(
                property Tuple(name String, value String)
            )
            """
        )


@pytest.mark.parametrize(
    "schema",
    [
        "`a` String, `b` String",  # a second quoted column on the line
        "`a` String, b String",  # a second UNQUOTED column on the line
        "a String",  # name not backtick-quoted
        "`a`",  # no type
        "`` String",  # empty name
        "`t` Tuple(bucket String, key String)",  # field names, one line
        "`t` Tuple (\n`x` String)",  # a space before the paren
        "`m` Map(String, String)",  # field types, comma inside the parens
        "`e` Enum8('a' = 1)",  # valid ClickHouse, deliberately unsupported
    ],
)
def test_a_declaration_it_cannot_read_raises_rather_than_guessing(schema):
    with pytest.raises(ValueError, match="not flat"):
        lambda_function.flat_schema_columns(schema)


def test_a_flat_schema_reads_cleanly():
    assert lambda_function.flat_schema_columns(
        """
        `sha` String,
        `tags` Array(Array(String)),
        `when` DateTime64(3),
        `ok` Bool
        """
    ) == ["`sha`", "`tags`", "`when`", "`ok`"]


def test_merges_insert_names_its_columns():
    sql = captured_query(
        lambda_function.merges_adapter, "default.merges", "bkt", "some/key.json"
    )
    expected = ", ".join(lambda_function.MERGES_COLUMNS)
    assert f"insert into default.merges ({expected})" in sql


def test_a_caller_passing_no_columns_still_emits_the_positional_form():
    # The whole point of `columns` being opt-in: the other tables this lambda
    # serves must emit exactly what they emitted before.
    sql = captured_query(
        lambda_function.merge_bases_adapter,
        "default.merge_bases",
        "bkt",
        "some/key.json",
    )
    assert "insert into default.merge_bases\n" in sql
    assert "insert into default.merge_bases (" not in sql


def test_columns_none_and_columns_omitted_produce_identical_sql():
    args = ("default.t", "bkt", "k", "`a` String", ["none"], "JSONEachRow")
    assert captured_query(lambda_function.general_adapter, *args) == captured_query(
        lambda_function.general_adapter, *args, columns=None
    )


def test_the_named_list_is_used_verbatim_in_order():
    # Two names for the two expressions a one-field structure produces (the
    # field, then the meta tuple), so the fixture is arity-correct SQL. The
    # names are deliberately out of alphabetical order: anything that sorted or
    # reordered the list would render `(`a`, `z`)`.
    sql = captured_query(
        lambda_function.general_adapter,
        "default.t",
        "bkt",
        "k",
        "`a` String",
        ["none"],
        "JSONEachRow",
        columns=["`z`", "`a`"],
    )
    assert "insert into default.t (`z`, `a`)" in sql


def test_merges_adapter_is_the_only_caller_that_names_columns():
    # Source-level via AST, deliberately: invoking every adapter would need S3
    # and a cluster, and a textual search for one spelling would miss
    # `columns=SOMETHING_ELSE`, an inline list, or a seventh positional
    # argument. If a second table opts in, that is a decision someone should
    # make on purpose, and this test is where they notice.
    tree = ast.parse((LAMBDA_DIR / "lambda_function.py").read_text())
    naming = []
    for func in ast.walk(tree):
        if not isinstance(func, ast.FunctionDef):
            continue
        for node in ast.walk(func):
            if not isinstance(node, ast.Call):
                continue
            if getattr(node.func, "id", None) != "general_adapter":
                continue
            passes_columns = len(node.args) >= 7 or any(
                kw.arg == "columns" for kw in node.keywords
            )
            if passes_columns:
                naming.append(func.name)
    assert naming == ["merges_adapter"]
