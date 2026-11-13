"""Tests for the torchci-reports-batch-ingest lambda: reading the SQS batch, the SQL
it sends, and which messages it reports as failed.

Lives here so the "Test aws lambda" job in tests.yml picks it up. The lambdas'
directory names are hyphenated and so cannot be imported as packages; hence the
path loads below.
"""

import hashlib
import importlib.util
import json
import pathlib
import re
import sys
import types
from unittest import mock

import pytest


LAMBDAS = pathlib.Path(__file__).resolve().parents[1]

try:  # pragma: no cover - present in CI via test_requirements.txt
    import clickhouse_connect  # noqa: F401
except ImportError:
    sys.modules["clickhouse_connect"] = types.SimpleNamespace(
        get_client=lambda **kwargs: None
    )


def load(name, directory):
    spec = importlib.util.spec_from_file_location(
        name, LAMBDAS / directory / "lambda_function.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


lf = load("torchci_reports_batch_ingest_lambda", "torchci-reports-batch-ingest")

FOLDER = "torchci-reports/pytorch/pytorch/18999999900/53000000001"


def key(name, folder=FOLDER):
    return f"{folder}/{name}.report.jsonl"


def message(message_id, object_key, bucket="gha-artifacts"):
    body = {
        "source": "aws.s3",
        "detail-type": "Object Created",
        "detail": {
            "bucket": {"name": bucket},
            "object": {"key": object_key, "size": 1000},
            "reason": "PutObject",
        },
    }
    return {"messageId": message_id, "body": json.dumps(body)}


class Context:
    """Lambda's context. Each call to get_remaining_time_in_millis gives the next of
    `seconds_left`, then the last one again."""

    def __init__(self, *seconds_left):
        self.seconds_left = list(seconds_left or [900])

    def get_remaining_time_in_millis(self):
        if len(self.seconds_left) > 1:
            return self.seconds_left.pop(0) * 1000
        return self.seconds_left[0] * 1000


class Result:
    def __init__(self, rows):
        self.result_rows = rows


def flat(sql):
    """`sql` without its layout: whitespace collapsed to one space, and dropped next
    to brackets and commas. Queries and the fragments checked against them both go
    through it, so the checks don't depend on how the SQL is laid out."""
    return re.sub(r" ?([(),]) ?", r"\1", " ".join(sql.split()))


def fake_client(error=None, where="insert into"):
    """A ClickHouse client that records its queries, flattened, and fails those
    containing `where`, in any case, with `error`, if given."""
    client = mock.Mock()
    client.queries = []

    def query(sql):
        sql = flat(sql)
        client.queries.append(sql)
        if error and where.lower() in sql.lower():
            raise Exception(error)
        if "from system.columns" in sql.lower():
            return Result(
                [(f"{name}{lf.TABLE_SUFFIX}", f"sipHash64({name})") for name in lf.IDS]
            )
        return Result([[7]])

    client.query.side_effect = query
    return client


def inserts(client, table=""):
    """The client's inserts into `table`, or into any table, in any case."""
    prefix = f"insert into {table}".lower()
    return [q for q in client.queries if q.lower().startswith(prefix)]


def table_name(name):
    """`name` in the settings fixture's database, with its suffix."""
    return f"{lf.DATABASE}.{name}{lf.TABLE_SUFFIX}"


@pytest.fixture
def settings(monkeypatch):
    monkeypatch.setattr(lf, "MODE", "on")
    monkeypatch.setattr(lf, "SAMPLE_PERCENT", 100)
    monkeypatch.setattr(lf, "TABLE_SUFFIX", "_batched")
    monkeypatch.setattr(lf, "DATABASE", "ci")
    return monkeypatch


def run(records, client, context=None):
    with mock.patch.object(lf, "get_clickhouse_client", lambda: client):
        return lf.lambda_handler({"Records": records}, context or Context())


def failed_ids(response):
    return sorted(item["itemIdentifier"] for item in response["batchItemFailures"])


def test_sql_matches_the_replicator(settings):
    """For one report, the queries are clickhouse-replicator-s3's, but for reading
    the file in a subquery grouped by file, and for the deduplication token.
    Layout is ignored: fake_client records the queries flattened."""
    replicator = load("replicator_for_batch_ingest_test", "clickhouse-replicator-s3")
    assert lf.REPORT_KEY.pattern == replicator.TEST_RUN_REPORTS_KEY.pattern
    settings.delenv("DATABASE", raising=False)
    defaults = load("batch_ingest_defaults_test", "torchci-reports-batch-ingest")
    assert defaults.DATABASE == replicator.TEST_RUN_REPORTS_DATABASE
    settings.setattr(lf, "DATABASE", replicator.TEST_RUN_REPORTS_DATABASE)
    settings.setattr(lf, "TABLE_SUFFIX", "")
    report = key("a")
    source = f"s3('https://gha-artifacts.s3.amazonaws.com/{report}', 'LineAsString')"
    token = hashlib.sha256(report.encode()).hexdigest()
    for mode in ("dry", "on"):
        settings.setattr(lf, "MODE", mode)
        settings.setenv("TEST_RUN_REPORTS_MODE", mode)
        single, batched = fake_client(), fake_client()
        with mock.patch.object(replicator, "get_clickhouse_client", lambda: single):
            replicator.test_run_reports_adapter(
                replicator.TEST_RUN_REPORTS_TABLE, "gha-artifacts", report
            )
        run([message("m1", report)], batched)
        assert batched.queries == [
            query.replace(
                flat(f"FROM {source}"),
                flat(f"FROM (SELECT line, _path AS path FROM {source})"),
            )
            .replace(
                flat("WHERE isValidJSON(line)"),
                flat("WHERE isValidJSON(line) GROUP BY path"),
            )
            .replace(f"'{report}:ingest-v", f"'{token}:ingest-v")
            for query in single.queries
        ]


def test_read_messages(settings):
    settings.setattr(lf, "SAMPLE_PERCENT", 50)
    records = [
        message("m1", key("a")),
        message("m2", key("a")),  # the same report queued twice
        message("m3", key("b")),
        message("m4", "torchci-reports/pytorch/pytorch/1/2/x.report.jsonl.tmp"),
        message("m5", key("c", "torchci-reports/pytorch/pytorch/18999999950/1")),
        {"messageId": "m6", "body": "not json"},
        message("m7", key("d"), bucket="another-bucket"),
    ]
    reports, unreadable = lf.read_messages(records)
    # run 18999999900 % 100 = 0 is sampled at 50%; 18999999950 % 100 = 50 is not
    assert reports == {key("a"): ["m1", "m2"], key("b"): ["m3"]}
    assert unreadable == ["m6"]


def test_build_statements(settings):
    ids = {column: f"<{column}>" for column in lf.IDS.values()}
    statements = [
        (table, flat(sql))
        for table, sql in lf.build_statements([key("b"), key("a")], ids)
    ]
    assert [table for table, _ in statements] == [
        table_name(name) for name in ("tests", "environments", "env_vars", "runs")
    ]
    unsuffixed = rf"\b{re.escape(lf.DATABASE)}\.(tests|environments|env_vars|runs)\b"
    for table, sql in statements:
        assert sql.startswith(flat(f"insert into {table} ("))
        # only the suffixed tables are read or written
        assert not re.search(unsuffixed, sql)
        # one read per report, joined into one source
        assert sql.count("FROM s3(") == 2
        assert sql.count("UNION ALL") == 1
        assert "<tests_id> AS tests_id" in sql
    tokens = [sql.count("insert_deduplication_token") for _, sql in statements]
    assert tokens == [0, 0, 0, 1]


def test_dedup_token_names_the_reports(settings):
    def token(keys):
        _, runs = lf.build_statements(keys, dict.fromkeys(lf.IDS.values(), ""))[3]
        return re.search(r"insert_deduplication_token = '([^']+)'", flat(runs))[1]

    assert token([key("a"), key("b")]) == token([key("b"), key("a")])
    assert token([key("a")]) != token([key("a"), key("b")])
    before = token([key("a")])
    settings.setattr(lf, "INGEST_VERSION", lf.INGEST_VERSION + 1)
    assert token([key("a")]) != before


def test_ingest_succeeds(settings):
    client = fake_client()
    records = [message(f"m{n}", key(n)) for n in "abc"]
    assert failed_ids(run(records, client)) == []
    # one statement per table, each reading all three reports
    assert [q.count("FROM s3(") for q in inserts(client)] == [3, 3, 3, 3]


def test_dry_mode_counts_without_writing(settings):
    settings.setattr(lf, "MODE", "dry")
    client = fake_client()
    assert failed_ids(run([message("m1", key("a"))], client)) == []
    counts = [q for q in client.queries if "system.columns" not in q]
    assert len(counts) == 4
    assert all(q.startswith(flat("select count() from (")) for q in counts)
    assert inserts(client) == []


def test_off_mode_deletes_unread(settings):
    settings.setattr(lf, "MODE", "off")
    client = fake_client()
    assert failed_ids(run([message("m1", key("a"))], client)) == []
    assert client.queries == []


def test_unknown_mode_is_rejected(monkeypatch):
    monkeypatch.setenv("MODE", "On")
    with pytest.raises(ValueError, match="MODE must be off, dry or on"):
        load("torchci_reports_batch_ingest_bad_mode", "torchci-reports-batch-ingest")


@pytest.mark.parametrize(
    "error", ["Code: 252. DB::Exception: Too many parts", "Connection refused"]
)
def test_transient_failure_returns_the_whole_batch(settings, error):
    client = fake_client(error)
    records = [message(f"m{n}", key(n)) for n in "abcd"]
    assert failed_ids(run(records, client)) == ["ma", "mb", "mc", "md"]
    # not retried a report at a time
    assert len(inserts(client)) == 1


@pytest.mark.parametrize(
    "error",
    [
        "Code: 117. DB::Exception: Incorrect data",
        # toUUID on a run line without a valid id
        "Code: 376. DB::Exception: Cannot parse uuid : Cannot parse UUID from String",
    ],
)
def test_data_failure_fails_only_the_bad_report(settings, error):
    client = fake_client(error, "c.report.jsonl")
    records = [message(f"m{n}", key(n)) for n in "abdef"]
    # the bad report, queued twice
    records += [message("mc", key("c")), message("mc2", key("c"))]
    assert failed_ids(run(records, client)) == ["mc", "mc2"]
    # the batch failed, then each good report went in on its own
    runs = inserts(client, table_name("runs"))
    assert [q.count("FROM s3(") for q in runs] == [1, 1, 1, 1, 1]


def test_data_failure_of_one_report_is_not_tried_again(settings):
    client = fake_client("Code: 117. DB::Exception: Incorrect data")
    assert failed_ids(run([message("m1", key("a"))], client)) == ["m1"]
    assert len(inserts(client)) == 1


def test_low_time_left_returns_reports_untried(settings):
    client = fake_client("Code: 117. DB::Exception: Incorrect data", "a.report.jsonl")
    records = [message(f"m{n}", key(n)) for n in "ab"]
    context = Context(lf.MIN_SECONDS_LEFT - 1)
    assert failed_ids(run(records, client, context)) == ["ma", "mb"]
    # only the batch was tried
    assert len(inserts(client)) == 1


def test_time_running_out_returns_the_rest_untried(settings):
    client = fake_client("Code: 117. DB::Exception: Incorrect data", "b.report.jsonl")
    records = [message(f"m{n}", key(n)) for n in "abc"]
    # time for report a on its own, then too little for b and c
    context = Context(900, lf.MIN_SECONDS_LEFT - 1)
    assert failed_ids(run(records, client, context)) == ["mb", "mc"]
    runs = inserts(client, table_name("runs"))
    assert [q.count("FROM s3(") for q in runs] == [1]


def test_id_defaults_failure_fails_every_message(settings):
    client = fake_client("Code: 60. unknown table", "system.columns")
    records = [message("m1", key("a")), {"messageId": "m2", "body": "{}"}]
    # m2 is unreadable, and fails alongside the ingest failures
    assert failed_ids(run(records, client)) == ["m1", "m2"]
    assert inserts(client) == []
