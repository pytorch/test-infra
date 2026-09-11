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
# the lambda derives them from MERGES_SCHEMA, so without an independent
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


def derived_merges_columns():
    return lambda_function.flat_schema_columns(lambda_function.MERGES_SCHEMA) + [
        lambda_function.META_COLUMN
    ]


def test_derived_columns_are_the_projection_the_table_expects():
    assert derived_merges_columns() == EXPECTED_MERGES_COLUMNS


def test_every_name_is_backtick_quoted():
    # An unquoted name would still be valid SQL for most of these, but `error`
    # is close enough to reserved that quoting is not optional by inspection --
    # so require it of all of them.
    for name in derived_merges_columns():
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
    # End to end, against the independently written projection rather than
    # against the derivation's own output.
    sql = captured_query(
        lambda_function.merges_adapter, "default.merges", "bkt", "some/key.json"
    )
    expected = ", ".join(EXPECTED_MERGES_COLUMNS)
    assert f"insert into default.merges ({expected})" in sql


def test_a_caller_that_does_not_opt_in_still_emits_the_positional_form():
    # The whole point of the flag being opt-in: the other tables this lambda
    # serves must emit exactly what they emitted before.
    sql = captured_query(
        lambda_function.merge_bases_adapter,
        "default.merge_bases",
        "bkt",
        "some/key.json",
    )
    assert "insert into default.merge_bases\n" in sql
    assert "insert into default.merge_bases (" not in sql


def test_opting_out_explicitly_and_omitting_the_flag_are_the_same_sql():
    args = ("default.t", "bkt", "k", "`a` String", ["none"], "JSONEachRow")
    assert captured_query(lambda_function.general_adapter, *args) == captured_query(
        lambda_function.general_adapter, *args, use_named_columns=False
    )


def test_the_names_follow_the_schema_order_with_the_meta_tuple_last():
    # Declared out of alphabetical order on purpose: anything that sorted the
    # derived names would render `(`a`, `z`, `_meta`)`.
    sql = captured_query(
        lambda_function.general_adapter,
        "default.t",
        "bkt",
        "k",
        "`z` String,\n`a` Int64",
        ["none"],
        "JSONEachRow",
        use_named_columns=True,
    )
    assert "insert into default.t (`z`, `a`, `_meta`)" in sql


def test_a_schema_the_parser_would_reject_is_fine_when_not_opted_in():
    # The restricted parser must never be applied to a caller that did not ask
    # for it -- most of the schemas in this file would fail it.
    sql = captured_query(
        lambda_function.general_adapter,
        "default.t",
        "bkt",
        "k",
        "`t` Tuple(bucket String, key String)",
        ["none"],
        "JSONEachRow",
    )
    assert "insert into default.t\n" in sql
    assert "insert into default.t (" not in sql


def test_opting_in_with_a_schema_it_cannot_read_raises():
    # Raised before the query is built, so it propagates out of
    # general_adapter rather than being logged as an insert failure. It can
    # only be reached by editing a schema constant, which is why this test --
    # which runs on every pull request -- is the gate that matters.
    with pytest.raises(ValueError, match="not flat"):
        captured_query(
            lambda_function.general_adapter,
            "default.t",
            "bkt",
            "k",
            "`t` Tuple(bucket String, key String)",
            ["none"],
            "JSONEachRow",
            use_named_columns=True,
        )


def opts_in(call):
    """True if this general_adapter() call turns named columns ON.

    Reads the VALUE, not merely the argument's presence: an explicit
    `use_named_columns=False` leaves the SQL positional and must not count.
    Anything that is not a literal False does count, including a name this
    cannot resolve -- unrecognised is treated as opting in, so the test errs
    toward flagging.
    """
    supplied = [kw.value for kw in call.keywords if kw.arg == "use_named_columns"]
    if len(call.args) >= 7:
        supplied.append(call.args[6])
    return any(
        not (isinstance(value, ast.Constant) and value.value is False)
        for value in supplied
    )


def test_merges_adapter_is_the_only_caller_that_turns_named_columns_on():
    # Source-level via AST, deliberately: invoking every adapter would need S3
    # and a cluster, and a textual search would miss the flag passed as a
    # seventh positional argument. Opting a second table in is a decision
    # someone should make on purpose -- both preconditions in
    # general_adapter's docstring have to be rechecked for it -- and this test
    # is where they notice.
    #
    # A source-convention guard, not structural enforcement: forwarding the
    # flag through **kwargs, or calling general_adapter through an alias,
    # would evade it.
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
            if opts_in(node):
                naming.append(func.name)
    assert naming == ["merges_adapter"]
