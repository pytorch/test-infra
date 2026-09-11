"""Checks on the one insert in the S3 replicator that names its target columns.

`general_adapter` inserts positionally by default. `merges_adapter` opts out by
passing `columns`, so `ai_not_related_checks` can be ALTERed into
`default.merges` before the schema string declares it. The risk that buys is
drift: `MERGES_COLUMNS` and `MERGES_SCHEMA` are two hand-maintained lists that
must stay in the same order, and a name that is not a column on the table would
fail every merge insert silently -- `general_adapter` routes the exception to
`errors.gen_errors` and nothing reads that table.

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


def test_schema_is_flat_so_the_name_scan_below_is_valid():
    # The next test reads column names line-wise. A nested `Tuple(...)` breaks
    # that: its inner fields sit on their own lines, backtick-quoted, and get
    # counted as columns even though `select *` produces one expression for the
    # whole tuple. The backtick count alone does not catch it -- a list that
    # wrongly included both the tuple and an inner field would balance -- so
    # reject the construct outright. Naming a tuple column here means teaching
    # this file to parse, which is the thing this PR exists to avoid.
    schema = lambda_function.MERGES_SCHEMA
    assert "tuple(" not in schema.lower(), "MERGES_SCHEMA is no longer flat"
    assert schema.count("`") % 2 == 0
    assert schema.count("`") // 2 == len(lambda_function.MERGES_COLUMNS) - 1


def test_columns_match_the_schema_string_in_order_with_meta_last():
    declared = [
        f"`{name}`"
        for name in re.findall(
            r"^\s*`([^`]+)`", lambda_function.MERGES_SCHEMA, re.MULTILINE
        )
    ]
    assert lambda_function.MERGES_COLUMNS[:-1] == declared
    assert lambda_function.MERGES_COLUMNS[-1] == "`_meta`"


def test_every_name_is_backtick_quoted():
    # An unquoted name would still be valid SQL for most of these, but `error`
    # is close enough to reserved that quoting is not optional by inspection --
    # so require it of all of them.
    for name in lambda_function.MERGES_COLUMNS:
        assert re.fullmatch(r"`[^`]+`", name), name


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
