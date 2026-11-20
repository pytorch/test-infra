"""`upload-report`: send a refit's report.json to HUD as one misc.ossci_uploaded_metrics row.

The row has the shape of pytorch's `emit_metric` (`tools/stats/upload_metrics.py`), with
METRIC_NAME as its metric name and the report as its `info`, every non-finite float in
it turned into null: one NaN in `info` makes ClickHouse read every key of it as 0. It is
written once, gzipped, to
`s3://ossci-raw-job-status/ossci_uploaded_metrics/td_scorer_refit_<run_id>_<attempt>.jsonl.gz`,
which the ClickHouse S3 replicator ingests. An existing key is never overwritten: holding
other bytes, it fails the run. It runs only in a schedule or workflow_dispatch run of
pytorch/test-infra on main, and writes nothing otherwise.
"""

import argparse
import gzip
import json
import logging
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional

from torchci.td.scorer import store


logger = logging.getLogger(__name__)

METRIC_NAME = "td_scorer_refit"
PREFIX = "ossci_uploaded_metrics/"
REPOSITORY = "pytorch/test-infra"
REF = "refs/heads/main"
EVENTS = ("schedule", "workflow_dispatch")
RUN_VARS = ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_RUN_NUMBER")
POSITIVE = re.compile(r"[1-9][0-9]*")


def finite(obj: Any) -> Any:
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: finite(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [finite(v) for v in obj]
    return obj


def refusal(env: Mapping[str, str]) -> Optional[str]:
    """Why this run must not upload, or None."""
    if env.get("GITHUB_REPOSITORY") != REPOSITORY:
        return f"GITHUB_REPOSITORY is not {REPOSITORY}"
    if env.get("GITHUB_REF") != REF:
        return f"GITHUB_REF is not {REF}"
    if env.get("GITHUB_EVENT_NAME") not in EVENTS:
        return f"GITHUB_EVENT_NAME is not one of {', '.join(EVENTS)}"
    for name in RUN_VARS:
        if not POSITIVE.fullmatch(env.get(name, "")):
            return f"{name} is not a positive integer"
    return None


def load_report(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"{path} is not a file")
    report = json.loads(path.read_text())
    if not isinstance(report, dict):
        raise ValueError(f"{path} is not a JSON object")
    return report


def row(
    report: dict[str, Any], env: Mapping[str, str], now: datetime
) -> dict[str, Any]:
    return {
        "repo": env["GITHUB_REPOSITORY"],
        "workflow": env.get("GITHUB_WORKFLOW", ""),
        "build_environment": "",
        "job": env.get("GITHUB_JOB", ""),
        "test_config": "",
        "pr_number": 0,
        "run_id": int(env["GITHUB_RUN_ID"]),
        "run_number": int(env["GITHUB_RUN_NUMBER"]),
        "run_attempt": int(env["GITHUB_RUN_ATTEMPT"]),
        "job_id": 0,
        "job_name": "",
        "metric_name": METRIC_NAME,
        "calling_file": os.path.basename(__file__),
        "calling_module": __name__,
        "calling_function": upload_report.__name__,
        "timestamp": now.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f"),
        "info": finite(report),
    }


def body(record: dict[str, Any]) -> bytes:
    line = json.dumps(record, allow_nan=False) + "\n"
    return gzip.compress(line.encode(), mtime=0)


def upload_report(args: argparse.Namespace) -> int:
    env = os.environ
    refused = refusal(env)
    if refused is not None:
        logger.error("not uploading the report: %s", refused)
        return 1
    try:
        report = load_report(Path(args.report))
    except (OSError, ValueError) as e:
        logger.error("not uploading the report: %s", e, exc_info=True)
        return 1
    data = body(row(report, env, datetime.now(timezone.utc)))
    name = f"{METRIC_NAME}_{env['GITHUB_RUN_ID']}_{env['GITHUB_RUN_ATTEMPT']}"
    s3 = store.S3Store(prefix=PREFIX)
    if s3.put_if_absent(name, data):
        logger.info("uploaded %s%s (%d bytes)", PREFIX, name, len(data))
        return 0
    if s3.get(name) == data:
        logger.info("%s%s already holds this report: left as it is", PREFIX, name)
        return 0
    message = f"{PREFIX}{name} was already written by another writer: not overwritten"
    logger.error(message)
    print(f"::error::{message}", flush=True)
    return 1


def add_parser(sub: Any) -> None:
    u = sub.add_parser(
        "upload-report", help="send refit's report to HUD (main runs only)"
    )
    u.add_argument("--report", required=True, help="the report.json refit wrote")
    u.set_defaults(func=upload_report)
