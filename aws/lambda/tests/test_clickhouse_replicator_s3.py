"""Checks on the one insert in the S3 replicator that names its target columns.

`general_adapter` inserts positionally by default; `merges_adapter` opts out via
`use_named_columns`. Hence the ordering rule: ALTER a column into
`default.merges` before `MERGES_SCHEMA` declares it. An omitted column takes its
default; a named column the table lacks fails the insert.

The names are derived from `MERGES_SCHEMA`, so the risk is a derivation bug. A
name that is not a column fails every merge insert silently -- `general_adapter`
routes the exception to `errors.gen_errors`, which nothing reads -- and a wrong
order can write into the wrong column without failing at all. Hence
`EXPECTED_MERGES_COLUMNS` below.

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


# The projection merges_adapter must write: destination names in the order its
# SELECT produces them, stated here rather than derived so the derivation is
# not compared against itself. Every name must be a column of default.merges.
# Order is the dangerous axis -- several share a type, so a mismatch can write
# into the wrong column without failing.
EXPECTED_MERGES_COLUMNS = [
    "`_id`",
    "`ai_not_related_checks`",
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
        lambda_function.meta_column("default.merges")
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


@pytest.mark.parametrize(
    "table",
    [
        "default.merge_bases",
        "default.queue_times_historical",
        "default.rerun_disabled_tests",
    ],
)
def test_the_three_tables_that_call_it_meta_get_meta(table):
    # Confirmed against system.columns on 2026-09-10: of the 21 tables
    # general_adapter serves these are the only three, and none has both.
    assert lambda_function.meta_column(table) == "`meta`"


@pytest.mark.parametrize("table", ["default.merges", "misc.stable_pushes", "a.b"])
def test_every_other_table_gets_the_underscore_spelling(table):
    assert lambda_function.meta_column(table) == "`_meta`"


def test_an_opted_in_insert_uses_the_tables_own_meta_spelling():
    # The end that matters: the destination list, not just the lookup.
    sql = captured_query(
        lambda_function.general_adapter,
        "default.merge_bases",
        "bkt",
        "k",
        "`sha` String",
        ["none"],
        "JSONEachRow",
        use_named_columns=True,
    )
    assert "insert into default.merge_bases (`sha`, `meta`)" in sql


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


# Test run reports: one zip per test job, matched by name; catalogs, then runs.

TEST_RUN_REPORTS_ZIP = (
    "pytorch/pytorch/37383941543/1/artifact/"
    "test-run-reports-test-distributed-6-8-lf-l-x86iamx-8-64_112017841325.report.zip"
)


def route(bucket, key, mode):
    with mock.patch.dict("os.environ", {"TEST_RUN_REPORTS_MODE": mode}):
        return lambda_function.extract_clickhouse_table_name(bucket, key)


@pytest.mark.parametrize(
    "key",
    [
        TEST_RUN_REPORTS_ZIP,
        "pytorch/pytorch/37383941543/2/artifact/"
        "test-run-reports-test-default-1-6-linux.rocm.gpu.gfx950.1_112017841999.report.zip",
    ],
)
@pytest.mark.parametrize("mode", ["dry", "on"])
def test_a_test_run_reports_zip_routes_to_runs(key, mode):
    assert route("gha-artifacts", key, mode) == "fortesting.runs"


@pytest.mark.parametrize("mode", ["off", "yes", ""])
def test_any_other_mode_routes_nothing(mode):
    assert route("gha-artifacts", TEST_RUN_REPORTS_ZIP, mode) is None


def test_the_default_mode_is_on():
    assert lambda_function.TEST_RUN_REPORTS_MODE == "on"
    with mock.patch.dict("os.environ", clear=True):
        assert lambda_function.test_run_reports_mode() == "on"
        table = lambda_function.extract_clickhouse_table_name(
            "gha-artifacts", TEST_RUN_REPORTS_ZIP
        )
    assert table == "fortesting.runs"


def test_the_environment_overrides_the_default_mode():
    with mock.patch.object(lambda_function, "TEST_RUN_REPORTS_MODE", "on"):
        assert route("gha-artifacts", TEST_RUN_REPORTS_ZIP, "off") is None


@pytest.mark.parametrize(
    "bucket,key",
    [
        ("gha-artifacts", "pytorch/pytorch/1/1/artifact/test-reports-test-x_1.zip"),
        ("gha-artifacts", "pytorch/pytorch/1/1/artifact/logs-test-x_1.zip"),
        ("gha-artifacts", "pytorch/pytorch/1/linux-jammy-py3.11-gcc11/artifacts.zip"),
        ("gha-artifacts", "pytorch/pytorch/1/1/artifact/test-run-reports-x_1.zip"),
        (
            "gha-artifacts",
            "pytorch/pytorch/1/1/artifact/sub/test-run-reports-x_1.report.zip",
        ),
        (
            "gha-artifacts",
            "pytorch/pytorch/1/1/artifact/test-run-reports-x'_1.report.zip",
        ),
        ("other-bucket", TEST_RUN_REPORTS_ZIP),
    ],
)
def test_no_other_zip_is_taken_for_a_test_run_reports_zip(bucket, key):
    assert route(bucket, key, "on") is None


def test_the_prefix_routes_are_unchanged():
    key = "test_jsons_while_running/1/2/python-pytest_x_x-0123.json"
    assert route("gha-artifacts", key, "on") == "tests.all_test_runs"


# Stand-ins for the catalogs' id DEFAULTs, as system.columns returns them.
ID_DEFAULTS = [
    ("tests", "tests_id(repo, file, language)"),
    ("environments", "environments_id(os, device_count)"),
    ("flags", "flags_id(flags)"),
]
ID_LOOKUP = "from system.columns"


def run_test_reports_adapter(mode, fail_on=None, id_defaults=ID_DEFAULTS):
    """Run the adapter with the ClickHouse client stubbed; return every SQL it
    sent after the id DEFAULT lookup, failing the first statement that writes or
    counts `fail_on`."""
    queries = []

    def query(sql):
        queries.append(sql)
        if ID_LOOKUP in sql:
            return mock.Mock(result_rows=list(id_defaults))
        if fail_on and (
            f"insert into fortesting.{fail_on} " in sql
            or (
                sql.startswith("select count()")
                and f"from fortesting.{fail_on} final)" in sql
            )
        ):
            raise RuntimeError("insert failed")
        return mock.Mock(result_rows=[[7]])

    client = mock.Mock()
    client.query.side_effect = query
    with mock.patch.object(lambda_function, "get_clickhouse_client", lambda: client):
        with mock.patch.dict("os.environ", {"TEST_RUN_REPORTS_MODE": mode}):
            lambda_function.test_run_reports_adapter(
                "fortesting.runs", "gha-artifacts", TEST_RUN_REPORTS_ZIP
            )
    assert ID_LOOKUP in queries[0]
    return queries[1:]


def insert_target(sql):
    return re.search(r"insert into ([\w.]+)", sql).group(1)


def test_the_catalogs_are_written_before_runs():
    targets = [insert_target(sql) for sql in run_test_reports_adapter("on")]
    assert targets == [
        "fortesting.tests",
        "fortesting.environments",
        "fortesting.flags",
        "fortesting.runs",
    ]


@pytest.mark.parametrize("mode", ["dry", "on"])
def test_every_statement_reads_the_reports_inside_the_zip_once(mode):
    source = (
        f"s3('https://gha-artifacts.s3.amazonaws.com/{TEST_RUN_REPORTS_ZIP}"
        " :: test/test-run-reports/*/*.jsonl', 'LineAsString')"
    )
    assert all(sql.count(source) == 1 for sql in run_test_reports_adapter(mode))


@pytest.mark.parametrize("mode", ["dry", "on"])
def test_every_statement_turns_on_the_archive_path_syntax(mode):
    # Our ClickHouse Cloud service turns it off, and every statement reads the
    # zip as `<archive> :: <file>`.
    for sql in run_test_reports_adapter(mode):
        assert ":: test/test-run-reports/*/*.jsonl" in sql
        assert "settings allow_archive_path_syntax = 1" in sql


def test_only_runs_carries_the_deduplication_token():
    token = f"insert_deduplication_token = '{TEST_RUN_REPORTS_ZIP}:ingest-v1'"
    queries = run_test_reports_adapter("on")
    assert [token in sql for sql in queries] == [False, False, False, True]


def test_the_catalogs_only_take_unseen_ids():
    tests, environments, flags, _ = run_test_reports_adapter("on")
    assert "where test_id not in (select id from fortesting.tests final)" in tests
    assert (
        "where env_id not in (select id from fortesting.environments final)"
        in environments
    )
    assert "where flags_id not in (select id from fortesting.flags final)" in flags


def test_a_failed_statement_is_logged_and_nothing_after_it_runs():
    queries = run_test_reports_adapter("on", fail_on="environments")
    assert [insert_target(sql) for sql in queries] == [
        "fortesting.tests",
        "fortesting.environments",
        "errors.gen_errors",
    ]
    assert '"table": "fortesting.environments"' in queries[-1]


def test_dry_mode_counts_and_writes_nothing(capsys):
    queries = run_test_reports_adapter("dry")
    assert len(queries) == 4
    assert all(sql.startswith("select count() from (") for sql in queries)
    assert not any("insert into" in sql for sql in queries)
    printed = capsys.readouterr().out.splitlines()
    assert [line.split(":")[1].strip() for line in printed] == [
        "tests",
        "environments",
        "flags",
        "runs",
    ]
    assert all(" 7 rows in " in line for line in printed)


def test_a_failed_dry_statement_is_logged_as_a_dry_run():
    queries = run_test_reports_adapter("dry", fail_on="environments")
    assert len(queries) == 3
    assert '"table": "fortesting.environments (dry run)"' in queries[-1]


@pytest.mark.parametrize("mode", ["dry", "on"])
def test_the_ids_are_the_catalogs_own_defaults(mode):
    # runs' ids are whatever the catalogs' id DEFAULTs say, so the lambda holds
    # no id logic of its own.
    for sql in run_test_reports_adapter(mode):
        assert "tests_id(repo, file, language) AS test_id" in sql
        assert "environments_id(os, device_count) AS env_id" in sql
        assert "flags_id(flags) AS flags_id" in sql
        assert "sipHash64" not in sql


@pytest.mark.parametrize("mode", ["dry", "on"])
def test_a_missing_id_default_is_logged_and_nothing_runs(mode):
    queries = run_test_reports_adapter(mode, id_defaults=ID_DEFAULTS[:2])
    assert [insert_target(sql) for sql in queries] == ["errors.gen_errors"]
    suffix = " (dry run)" if mode == "dry" else ""
    assert f'"table": "fortesting.runs ids{suffix}"' in queries[0]
    assert "no id DEFAULT in fortesting: flags" in queries[0]


def test_the_language_comes_from_each_run_line():
    # Passed through as written, so a value outside tests.language's enum fails
    # the insert; only a line without one becomes unknown.
    for sql in run_test_reports_adapter("on"):
        assert (
            "if(JSONHas(line, 'language'), JSONExtractString(line, 'language')," in sql
        )
        assert "startsWith(file, 'cpp/')" not in sql
        assert "IN ('python', 'cpp')" not in sql


def test_runs_take_the_report_uuid_from_the_file_name():
    # Until reports carry their uuid, the file name's 16 hex digits become the
    # low half of one; the format() escaping must leave a {16} quantifier.
    *_, runs = run_test_reports_adapter("on")
    assert "extract(path, '-([0-9a-f]{16})[.]jsonl$') AS report_hex" in runs
    assert "github_workflow_job_id, report_uuid, rerun_number" in runs


def test_runs_leave_properties_to_its_default():
    # Until what goes in runs.properties is decided, nothing writes it.
    *_, runs = run_test_reports_adapter("on")
    assert "started_at, ended_at) settings" in runs
    assert not any("properties" in sql for sql in run_test_reports_adapter("on"))


def test_only_set_flags_are_stored_and_hashed():
    # flags drops off ('0') and unset ('') entries, so the stored map and
    # flags_id both come from the filtered map.
    for sql in run_test_reports_adapter("on"):
        assert "mapFilter((k, v) -> v NOT IN ('0', '')," in sql
        assert "flags_id(flags) AS flags_id" in sql
