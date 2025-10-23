"""
Generate a report of:
1) actual revert commits in pytorch/pytorch over a given period with a left join
   to autorevert decisions (default view), or
2) autorevert decisions (reverts) over a given period with a left join to actual
   revert commits (reverse view).

Default view columns (actual → autorevert):
- revert_time (UTC)
- original_sha (the commit being reverted)
- category (from -c flag in the bot command comment, else from message, else 'uncategorized')
- reason (short reason parsed from the revert commit message, if present)
- author (GitHub login from the bot command 'on behalf of' attribution in the message)
- comment_url (link to the bot command comment if present)
- has_autorevert (yes/no) — whether misc.autorevert_events_v2 recorded a revert for original_sha

Reverse view columns (autorevert → actual):
- ts (UTC)
- sha
- workflows
- signal_keys
- matching_actual_revert

Usage examples:
- python -m pytorch_auto_revert.testers.actual_reverts_report --start "2025-09-16 22:18:51" --end "2025-09-24 00:00:00"
- python -m pytorch_auto_revert.testers.actual_reverts_report --start "2025-09-16 22:18:51" --format csv > reverts.csv
- python -m pytorch_auto_revert.testers.actual_reverts_report --start "2025-09-16 22:18:51" --mode auto-to-actual

This script uses the ClickHouse client configuration from environment variables
as done by the project entrypoint (CLICKHOUSE_HOST, CLICKHOUSE_PORT, CLICKHOUSE_USERNAME,
CLICKHOUSE_PASSWORD, CLICKHOUSE_DATABASE). You may also use a .env file.
"""

from __future__ import annotations

import argparse
import csv
import os
from datetime import datetime, timezone
from typing import Any, Iterable, List, Tuple

from dotenv import load_dotenv

from ..clickhouse_client_helper import CHCliFactory, ensure_utc_datetime


def parse_utc(s: str) -> datetime:
    """Parse a timestamp as UTC. Supports naive (assumed UTC) or TZ-aware strings."""
    # Allow common formats: ISO8601 or "YYYY-MM-DD HH:MM:SS"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
    return ensure_utc_datetime(dt)


def setup_ch_from_env() -> None:
    host = os.environ.get("CLICKHOUSE_HOST", "")
    port = int(os.environ.get("CLICKHOUSE_PORT", "8443"))
    username = os.environ.get("CLICKHOUSE_USERNAME", "")
    password = os.environ.get("CLICKHOUSE_PASSWORD", "")
    database = os.environ.get("CLICKHOUSE_DATABASE", "default")
    CHCliFactory.setup_client(host, port, username, password, database)


def run_query_actual_to_auto(
    start: datetime, end: datetime
) -> Tuple[List[str], List[Tuple[Any, ...]]]:
    """Default view: actual reverts → left join autorevert decisions."""
    client = CHCliFactory().client

    sql = """
    WITH
        toDateTime64({start:DateTime64(9)}, 9) AS start_ts,
        toDateTime64({end:DateTime64(9)}, 9)   AS end_ts

    -- 1) Per-revert-commit rows (only bot-driven commits with author + comment id)
    , revert_by_sha AS (
        SELECT
            commit.id                           AS revert_sha,
            min(commit.timestamp)               AS revert_time,
            anyHeavy(commit.message)            AS message,
            regexpExtract(message, '(?s)This reverts commit ([0-9a-fA-F]{40})', 1) AS original_sha,
            regexpExtract(message, '(?s)on behalf of https://github.com/([A-Za-z0-9-]+)', 1) AS command_author,
            nullIf(trim(BOTH ' ' FROM regexpExtract(message, '(?s)due to (.*?)(?: \\([[]comment|$)', 1)), '') AS reason,
            regexpExtract(message,
                          '(?s)\\[comment\\]\\((https://github.com/pytorch/pytorch/pull/\\d+#issuecomment-\\d+)\\)', 1
            ) AS comment_url,
            toInt64OrNull(regexpExtract(message, '#issuecomment-(\\d+)', 1)) AS comment_id,
            regexpExtract(message, '-c\\s+(\\w+)', 1) AS category_hint
        FROM default.push
        ARRAY JOIN commits AS commit
        WHERE tupleElement(repository, 'full_name') = 'pytorch/pytorch'
          AND commit.timestamp >= start_ts AND commit.timestamp < end_ts
          AND match(commit.message, '(?s)This reverts commit [0-9a-fA-F]{40}')
        GROUP BY commit.id
        HAVING comment_id IS NOT NULL AND command_author != ''
    )

    -- 2) Join comment to get authoritative category from -c flag
    , revert_enriched AS (
        SELECT
            r.revert_sha,
            r.revert_time,
            r.original_sha,
            r.command_author,
            r.reason,
            r.comment_url,
            lowerUTF8(nullIf(ic.ic_body_category, '')) AS comment_category,
            lowerUTF8(nullIf(r.category_hint, ''))     AS message_category
        FROM revert_by_sha AS r
        LEFT JOIN (
            SELECT id, regexpExtract(body, '-c\\s+(\\w+)', 1) AS ic_body_category
            FROM default.issue_comment
        ) AS ic
        ON ic.id = r.comment_id
    )

    -- 3) Aggregate to one row per original_sha (earliest revert attempt)
    , per_original AS (
        SELECT
            original_sha,
            argMin(tuple(
                revert_time,
                reason,
                command_author,
                comment_url,
                if(comment_category IN ('nosignal','ignoredsignal','landrace','weird','ghfirst'), comment_category,
                   if(message_category IN ('nosignal','ignoredsignal','landrace','weird','ghfirst'), message_category,
                      'uncategorized'))
            ), revert_time) AS fields
        FROM revert_enriched
        GROUP BY original_sha
    )

    -- 4) Autorevert decisions (non-dry-run) keyed by original sha
    , auto AS (
        SELECT commit_sha
        FROM misc.autorevert_events_v2
        WHERE dry_run = 0 AND action = 'revert'
        GROUP BY commit_sha
    )

    SELECT
        tupleElement(fields, 1)                           AS revert_time,
        original_sha,
        tupleElement(fields, 5)                           AS category,
        tupleElement(fields, 2)                           AS reason,
        tupleElement(fields, 3)                           AS author,
        tupleElement(fields, 4)                           AS comment_url,
        if(auto.commit_sha != '', 'yes', 'no')            AS has_autorevert
    FROM per_original
    LEFT JOIN auto ON auto.commit_sha = per_original.original_sha
    ORDER BY revert_time
    """

    res = client.query(sql, parameters={"start": start, "end": end})
    headers = [
        "revert_time",
        "original_sha",
        "category",
        "reason",
        "author",
        "comment_url",
        "has_autorevert",
    ]
    rows = [tuple(row) for row in res.result_rows]
    return headers, rows


def run_query_auto_to_actual(
    start: datetime, end: datetime
) -> Tuple[List[str], List[Tuple[Any, ...]]]:
    """Reverse view: autorevert decisions (reverts) → left join actual reverts."""
    client = CHCliFactory().client

    sql = """
    WITH
        toDateTime64({start:DateTime64(9)}, 9) AS start_ts,
        toDateTime64({end:DateTime64(9)}, 9)   AS end_ts

    -- A) Detect actual revert commits (bot-driven) within window
    , revert_by_sha AS (
        SELECT
            commit.id                           AS revert_sha,
            min(commit.timestamp)               AS revert_time,
            anyHeavy(commit.message)            AS message,
            regexpExtract(message, '(?s)This reverts commit ([0-9a-fA-F]{40})', 1) AS original_sha,
            toInt64OrNull(regexpExtract(message, '#issuecomment-(\\d+)', 1)) AS comment_id,
            regexpExtract(message, '(?s)on behalf of https://github.com/([A-Za-z0-9-]+)', 1) AS command_author,
            regexpExtract(message,
                          '(?s)\\[comment\\]\\((https://github.com/pytorch/pytorch/pull/\\d+#issuecomment-\\d+)\\)', 1
            ) AS comment_url
        FROM default.push
        ARRAY JOIN commits AS commit
        WHERE tupleElement(repository, 'full_name') = 'pytorch/pytorch'
          AND commit.timestamp >= start_ts AND commit.timestamp < end_ts
          AND match(commit.message, '(?s)This reverts commit [0-9a-fA-F]{40}')
        GROUP BY commit.id
        HAVING comment_id IS NOT NULL AND command_author != ''
    )

    -- B) Map original_sha → earliest matching revert_sha within window
    , per_original AS (
        SELECT
            original_sha,
            argMin(revert_sha, revert_time)    AS matching_revert_sha,
            argMin(comment_url, revert_time)   AS matching_comment_url
        FROM revert_by_sha
        GROUP BY original_sha
    )

    -- C) Autorevert decisions (non-dry-run) within window
    , auto AS (
        SELECT ts, commit_sha, workflows, source_signal_keys
        FROM misc.autorevert_events_v2
        WHERE repo = 'pytorch/pytorch'
          AND dry_run = 0 AND action = 'revert'
          AND ts >= start_ts AND ts < end_ts
    )

    SELECT
        auto.ts                                   AS ts,
        toString(auto.commit_sha)                 AS sha,
        auto.workflows                            AS workflows,
        auto.source_signal_keys                   AS signal_keys,
        per_original.matching_comment_url         AS comment_url,
        toString(per_original.matching_revert_sha) AS revert_sha
    FROM auto
    LEFT JOIN per_original ON per_original.original_sha = auto.commit_sha
    ORDER BY ts
    """

    res = client.query(sql, parameters={"start": start, "end": end})
    headers = [
        "ts (utc)",
        "sha",
        "workflows",
        "signal keys",
        "comment_url",
        "revert sha",
    ]
    rows = [tuple(row) for row in res.result_rows]
    return headers, rows


def print_table(headers: List[str], rows: List[Tuple[Any, ...]]) -> None:
    # Pretty print with simple width calculation and trimming long cells
    widths = [len(h) for h in headers]
    # Cap for long columns when present to keep output readable
    caps = {}
    if "reason" in headers:
        caps[headers.index("reason")] = 100
    if "comment_url" in headers:
        caps[headers.index("comment_url")] = 120
    for row in rows:
        for i, val in enumerate(row):
            sval = "" if val is None else str(val)
            if i in caps and len(sval) > caps[i]:
                sval = sval[: caps[i] - 1] + "…"
            widths[i] = max(widths[i], len(sval))

    def fmt_row(vals: Iterable[Any]) -> str:
        parts: List[str] = []
        for i, v in enumerate(vals):
            sval = "" if v is None else str(v)
            if i in caps and len(sval) > caps[i]:
                sval = sval[: caps[i] - 1] + "…"
            parts.append(sval.ljust(widths[i]))
        return " | ".join(parts)

    print(fmt_row(headers))
    print("-+-".join("-" * w for w in widths))
    for row in rows:
        print(fmt_row(row))


def write_csv(headers: List[str], rows: List[Tuple[Any, ...]], fp) -> None:
    writer = csv.writer(fp)
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)


def main() -> None:
    load_dotenv()

    ap = argparse.ArgumentParser(
        description=(
            "Report reverts vs autorevert decisions for a date range (UTC).\n"
            "Default view: actual reverts → left join autorevert decisions.\n"
            "Reverse view: autorevert decisions → left join actual reverts."
        )
    )
    ap.add_argument(
        "--start", required=True, help="Start time UTC (e.g. '2025-09-16 22:18:51')"
    )
    ap.add_argument("--end", default=None, help="End time UTC (default: now)")
    ap.add_argument(
        "--mode",
        choices=["actual-to-auto", "auto-to-actual"],
        default="actual-to-auto",
        help="Which view to generate",
    )
    ap.add_argument(
        "--format", choices=["table", "csv"], default="table", help="Output format"
    )
    args = ap.parse_args()

    start = parse_utc(args.start)
    end = parse_utc(args.end) if args.end else datetime.now(timezone.utc)

    setup_ch_from_env()
    if args.mode == "auto-to-actual":
        headers, rows = run_query_auto_to_actual(start, end)
    else:
        headers, rows = run_query_actual_to_auto(start, end)

    if args.format == "csv":
        write_csv(headers, rows, fp=os.sys.stdout)
    else:
        print_table(headers, rows)


if __name__ == "__main__":
    main()
