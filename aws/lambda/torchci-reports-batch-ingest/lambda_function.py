"""Batched ingest of test run reports into ClickHouse.

Each test process writes one JSONL report, and each test job uploads its reports
when it ends, one object each, to gha-artifacts as
torchci-reports/<org>/<repo>/<run id>/<job id>/<file>-<report uuid>.report.jsonl
(pytorch/pytorch torch/testing/_internal/torchci/README.md). An EventBridge rule
queues one SQS message per report, and this function's event source mapping
delivers them in batches. The rule, the queue and the mapping, with its batch
size, batching window and concurrency, are in pytorch-gha-infra's
torchci_reports_batch.tf.

ClickHouse reads the reports from S3 itself, so the function only builds SQL:
clickhouse-replicator-s3's report statements, run once over the whole batch
instead of once per report. The SQL differs only in reading many files, so their
lines are grouped by file, in TABLE_SUFFIX on the table names, and in runs'
deduplication token, which names the batch's reports.

The function returns the messages it could not ingest as batchItemFailures. SQS
delivers only those again, and moves one that keeps failing to the dead-letter
queue; the event source mapping deletes the rest.
"""

import hashlib
import json
import os
import re
import time
import urllib.parse
from collections import defaultdict
from functools import lru_cache
from typing import Any, Dict, List, Tuple

import clickhouse_connect


CLICKHOUSE_ENDPOINT = os.getenv("CLICKHOUSE_ENDPOINT", "")
CLICKHOUSE_USERNAME = os.getenv("CLICKHOUSE_USERNAME", "default")
CLICKHOUSE_PASSWORD = os.getenv("CLICKHOUSE_PASSWORD", "")

# off: nothing is ingested, and the reports' messages are deleted. dry: the
# reports are read and parsed, and the rows each statement would insert are
# counted and printed; nothing is written. on: ingest.
MODE = os.getenv("MODE", "dry")
if MODE not in ("off", "dry", "on"):
    raise ValueError(f"MODE must be off, dry or on, not {MODE!r}")
DATABASE = os.getenv("DATABASE", "ci")
# Appended to every table name: _batched writes a parallel copy of the tables, to
# compare with clickhouse-replicator-s3's; empty writes the tables themselves.
TABLE_SUFFIX = os.getenv("TABLE_SUFFIX", "_batched")
# The percent of workflow runs whose reports are ingested, picked by run id so
# that the reports of a run's jobs, in every attempt, are all ingested or none are.
SAMPLE_PERCENT = int(os.getenv("SAMPLE_PERCENT", "10"))
# When a batch is ingested a report at a time (see ingest), a report isn't started
# with less of the invocation left than this; it is delivered again instead.
MIN_SECONDS_LEFT = 120

BUCKET = "gha-artifacts"

# From here through STATEMENTS: clickhouse-replicator-s3's TEST_RUN_REPORTS_*,
# which test_sql_matches_the_replicator checks these against. The key pattern also
# limits the name to characters that are safe in a SQL string literal.
REPORT_KEY = re.compile(
    r"^torchci-reports/[\w.-]+/[\w.-]+/(\d+)/\d+/[\w.-]+\.report\.jsonl$"
)
# 1.0 is the first stable report format; 0.x reports are not ingested.
SCHEMA_VERSIONS = "('1.0')"
# Part of the deduplication token: bump it to ingest the same reports again
# after a fix.
INGEST_VERSION = 1
OUTCOMES = (
    "('passed', 'failed', 'error', 'skipped', 'xfailed', 'xpassed', 'crashed', "
    "'timed_out')"
)
ENVIRONMENT = [
    "os",
    "os_version",
    "cpu_architecture",
    "cpu_capability",
    "python_version",
    "cc_compiler",
    "cc_compiler_version",
    "accelerator",
    "accelerator_version",
    "device_name",
]

# The catalogs whose id DEFAULT fills each of runs' id columns.
IDS = {
    "tests": "tests_id",
    "environments": "environments_id",
    "env_vars": "env_vars_id",
}

# One row per run line, carrying its report's report line. Each report is read
# once: its lines are grouped by file, its report line is picked out, then its run
# lines are unfolded. The ids are the catalogs' own id DEFAULTs, read when a batch
# is ingested and evaluated over the columns of the same names, so runs gets the
# ids the catalogs compute and a change to them needs no change here.
ROWS = """
WITH
    files AS (
        SELECT
            anyIf(line, JSONExtractString(line, 'type') = 'report') AS report_line,
            groupArrayIf(line, JSONExtractString(line, 'type') = 'run') AS run_lines
        FROM (
            {sources}
        )
        -- a line cut off by a killed test process is skipped
        WHERE isValidJSON(line)
        GROUP BY path
    ),
    report_rows AS (
        SELECT
            JSONExtractString(report_line, 'repo') AS repo,
            JSONExtractInt(report_line, 'github_workflow_job_id') AS github_workflow_job_id,
            -- the zero UUID when the report does not give a valid one
            toUUIDOrZero(JSONExtractString(report_line, 'report_uuid')) AS report_uuid,
            {environment},
            toUInt8(JSONExtractUInt(report_line, 'environment', 'device_count')) AS device_count,
            -- the report's flags list every registered flag and setting; the
            -- env_vars table keeps those that are set, so off ('0') and unset ('')
            -- ones are dropped
            mapFilter((k, v) -> v NOT IN ('0', ''),
                JSONExtract(report_line, 'flags', 'Map(String, String)')) AS env_vars,
            -- a missing or invalid one fails the insert, so a producer bug is
            -- logged, not hidden
            toUUID(JSONExtractString(line, 'id')) AS id,
            JSONExtractString(line, 'file') AS file,
            JSONExtractString(line, 'suite') AS suite,
            JSONExtractString(line, 'case_name') AS case_name,
            JSONExtractString(line, 'declared_case_name') AS declared_case_name,
            toUInt16(JSONExtractUInt(line, 'rerun_number')) AS rerun_number,
            if(JSONExtractString(line, 'outcome') IN {outcomes},
                JSONExtractString(line, 'outcome'), 'unknown') AS outcome,
            leftUTF8(JSONExtractString(line, 'outcome_summary'), 256) AS outcome_summary,
            fromUnixTimestamp64Milli(JSONExtractInt(line, 'started_at'), 'UTC') AS started_at,
            fromUnixTimestamp64Milli(JSONExtractInt(line, 'ended_at'), 'UTC') AS ended_at,
            -- as the run line says, or unknown when it does not say; any other
            -- value fails the insert, so a producer bug is logged, not hidden
            if(JSONHas(line, 'language'), JSONExtractString(line, 'language'),
                'unknown') AS language,
            {tests_id} AS tests_id,
            {environments_id} AS environments_id,
            {env_vars_id} AS env_vars_id
        FROM files
        ARRAY JOIN run_lines AS line
        WHERE JSONExtractString(report_line, 'schema_version') IN {versions}
          AND repo != ''
          AND github_workflow_job_id != 0
    )
"""

# (table, columns, select), in order: the catalogs get rows only for ids they
# lack (read with FINAL, as their schema requires), so first_seen_at stays the
# first sighting and a repeat inserts nothing; runs then gets every run. Its
# deduplication token names the batch's reports, so a repeat of the same batch
# inserts nothing; a report repeated in another batch is inserted again, and runs,
# a ReplacingMergeTree, collapses the copies as it merges. The lookup in tests
# holds only the reports' own ids, as holding all of tests' ids is costly.
STATEMENTS = [
    (
        "tests",
        "repo, file, suite, case_name, declared_case_name, language",
        """
        select repo, file, suite, case_name, declared_case_name, language
        from report_rows
        where tests_id not in (
            select id from {database}.tests{suffix} final
            where id in (select tests_id from report_rows)
        )
        limit 1 by tests_id
        """,
    ),
    (
        "environments",
        "{environment_columns}, device_count",
        """
        select {environment_columns}, device_count
        from report_rows
        where environments_id not in (select id from {database}.environments{suffix} final)
        limit 1 by environments_id
        """,
    ),
    (
        "env_vars",
        "env_vars",
        """
        select env_vars
        from report_rows
        where env_vars_id not in (select id from {database}.env_vars{suffix} final)
        limit 1 by env_vars_id
        """,
    ),
    (
        "runs",
        "tests_id, environments_id, env_vars_id, github_workflow_job_id, report_uuid, "
        "id, rerun_number, outcome, outcome_summary, started_at, ended_at",
        """
        select tests_id, environments_id, env_vars_id, github_workflow_job_id,
               report_uuid, id, rerun_number, outcome, outcome_summary,
               started_at, ended_at
        from report_rows
        """,
    ),
]

# ClickHouse errors that say nothing about the reports: the server was busy, out
# of memory or timed out. A batch that fails with one, or with an error that has
# no ClickHouse code (e.g. a connection failure), is delivered again whole.
TRANSIENT_ERROR_CODES = {
    159,  # TIMEOUT_EXCEEDED
    202,  # TOO_MANY_SIMULTANEOUS_QUERIES
    209,  # SOCKET_TIMEOUT
    210,  # NETWORK_ERROR
    241,  # MEMORY_LIMIT_EXCEEDED
    252,  # TOO_MANY_PARTS
    394,  # QUERY_WAS_CANCELLED
}


@lru_cache(maxsize=1)
def get_clickhouse_client() -> Any:
    return clickhouse_connect.get_client(
        host=CLICKHOUSE_ENDPOINT,
        user=CLICKHOUSE_USERNAME,
        password=CLICKHOUSE_PASSWORD,
        secure=True,
    )


def lambda_handler(event: Any, context: Any) -> Dict[str, List[Dict[str, str]]]:
    records = event["Records"]
    reports, failed = read_messages(records)
    if reports and MODE != "off":
        failed += ingest(reports, context)
    summary = {
        "mode": MODE,
        "messages": len(records),
        "reports": len(reports),
        "failed_messages": len(failed),
    }
    print(f"Finish processing {json.dumps(summary)}")
    return {"batchItemFailures": [{"itemIdentifier": i} for i in failed]}


def read_messages(records: List[Any]) -> Tuple[Dict[str, List[str]], List[str]]:
    """The ids of the messages that queued each sampled report, by the report's
    key, and the ids of the messages that could not be read. Each message is an
    EventBridge S3 Object Created event. An object that isn't a report, or a report
    of a run outside the sample, is skipped and its message deleted; an unreadable
    message is failed, so that it ends up in the dead-letter queue."""
    reports: Dict[str, List[str]] = defaultdict(list)
    unreadable: List[str] = []
    for record in records:
        message_id = record["messageId"]
        try:
            detail = json.loads(record["body"])["detail"]
            bucket, key = detail["bucket"]["name"], detail["object"]["key"]
            match = REPORT_KEY.match(key)
        except (KeyError, TypeError, ValueError) as error:
            print(f"Unreadable message {message_id}: {error}")
            unreadable.append(message_id)
            continue
        if bucket != BUCKET or not match:
            print(f"Skipping s3://{bucket}/{key}: not a test run report")
        elif int(match[1]) % 100 < SAMPLE_PERCENT:
            reports[key].append(message_id)
    return dict(reports), unreadable


def ingest(reports: Dict[str, List[str]], context: Any) -> List[str]:
    """Ingest the batch's reports and return the ids of the messages to deliver
    again. All the reports go in one set of statements. If those fail on the
    reports' data rather than on the server's state, the reports are ingested one
    at a time instead, so that a bad report fails only its own messages."""
    keys = sorted(reports)
    all_messages = [message_id for key in keys for message_id in reports[key]]
    try:
        ids = id_defaults()
    except Exception as error:
        print(f"Failed to read the catalogs' id defaults: {error}")
        return all_messages
    try:
        run_statements(keys, ids)
        return []
    except Exception as error:
        print(f"Failed to ingest {len(keys)} reports: {error}")
        if len(keys) == 1 or transient(error):
            return all_messages
    failed = []
    for key in keys:
        if context.get_remaining_time_in_millis() < MIN_SECONDS_LEFT * 1000:
            failed += reports[key]
            continue
        try:
            run_statements([key], ids)
        except Exception as error:
            print(f"Failed to ingest {key}: {error}")
            failed += reports[key]
    return failed


def id_defaults() -> Dict[str, str]:
    """The id DEFAULT expression of each catalog, keyed by the runs column it
    fills."""
    columns = {f"{name}{TABLE_SUFFIX}": column for name, column in IDS.items()}
    tables = ", ".join(f"'{name}'" for name in columns)
    defaults = dict(
        get_clickhouse_client()
        .query(
            "select table, default_expression from system.columns "
            f"where database = '{DATABASE}' and table in ({tables}) "
            "and name = 'id' and default_kind = 'DEFAULT'"
        )
        .result_rows
    )
    missing = [name for name in columns if name not in defaults]
    if missing:
        raise RuntimeError(f"no id DEFAULT in {DATABASE}: {', '.join(missing)}")
    return {column: defaults[name] for name, column in columns.items()}


def run_statements(keys: List[str], ids: Dict[str, str]) -> None:
    """Run the statements over the reports at `keys`, stopping at the first that
    fails, whose error then names its table."""
    started = time.monotonic()
    for table, sql in build_statements(keys, ids):
        try:
            result = get_clickhouse_client().query(sql)
        except Exception as error:
            raise RuntimeError(f"{table}: {error}") from error
        if MODE == "dry":
            print(f"Dry run: {table}: {result.result_rows[0][0]} rows")
    seconds = time.monotonic() - started
    print(f"Ran the statements over {len(keys)} reports in {seconds:.1f}s")


def build_statements(keys: List[str], ids: Dict[str, str]) -> List[Tuple[str, str]]:
    """(table, SQL) for each statement over the reports at `keys`, in order:
    inserts when MODE is on, or counts of the rows each would insert when it is
    dry."""
    sources = "\n            UNION ALL\n            ".join(
        "SELECT line, _path AS path FROM s3("
        f"'https://{BUCKET}.s3.amazonaws.com/{urllib.parse.quote(key)}', 'LineAsString')"
        for key in keys
    )
    environment_columns = ", ".join(ENVIRONMENT)
    rows = ROWS.format(
        sources=sources,
        environment=",\n            ".join(
            f"JSONExtractString(report_line, 'environment', '{name}') AS {name}"
            for name in ENVIRONMENT
        ),
        outcomes=OUTCOMES,
        versions=SCHEMA_VERSIONS,
        **ids,
    )
    token = hashlib.sha256("\n".join(sorted(keys)).encode()).hexdigest()
    result = []
    for target, columns, select in STATEMENTS:
        table = f"{DATABASE}.{target}{TABLE_SUFFIX}"
        select = select.format(
            database=DATABASE,
            suffix=TABLE_SUFFIX,
            environment_columns=environment_columns,
        )
        if MODE == "dry":
            sql = f"select count() from ({rows} {select})"
        else:
            columns = columns.format(environment_columns=environment_columns)
            settings = ""
            if target == "runs":
                settings = (
                    " settings insert_deduplication_token = "
                    f"'{token}:ingest-v{INGEST_VERSION}'"
                )
            sql = f"insert into {table} ({columns}){settings} {rows} {select}"
        result.append((table, sql))
    return result


def transient(error: Exception) -> bool:
    """Whether the error is one of TRANSIENT_ERROR_CODES, or has no ClickHouse
    code (e.g. a connection failure)."""
    match = re.search(r"Code: (\d+)", str(error))
    return match is None or int(match[1]) in TRANSIENT_ERROR_CODES
