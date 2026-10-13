#!/usr/bin/env python3
"""
CI-neutral CRCR callback reporter.

Builds the callback payload from environment variables and POSTs it to the
relay server.  CI-specific wrappers (GHA composite action, Buildkite step)
set the env vars and mint an OIDC token, then call this script.

Required env vars:
    OIDC_TOKEN        Bearer token for relay auth
    CALLBACK_URL      Relay endpoint URL
    STATUS            "in_progress" or "completed"
    WORKFLOW_NAME     Human-readable workflow name
    WORKFLOW_URL      URL to the CI run
    RUN_ID            Unique run identifier
    RUN_ATTEMPT       Attempt number (1-based)
    JOB_NAME          Job identifier for the check run name
    SCHEMA_VERSION    Payload schema version (currently "1")

Optional env vars:
    CONCLUSION              Job conclusion (required when STATUS=completed)
    CLIENT_PAYLOAD          JSON string of the dispatch payload (PR/push mode)
    DELIVERY_ID_OVERRIDE    Upstream commit SHA (nightly/periodic self-report)
    EVENT_TYPE_OVERRIDE     "nightly" or "periodic" (self-report)
    CHECK_RUN_ID            GitHub check run ID (falls back to RUN_ID-RUN_ATTEMPT)
    TEST_RESULTS            JSON string with test result summary
    TRIAGE_VERDICT          JSON object with a triage verdict for this job
    ARTIFACT_URL            URL to downstream artifacts
    MAX_TIME                curl --max-time (default 10)
    RATE_LIMIT_RETRIES      Retries on the relay's rate-limit 429 (default 5)
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from typing import NamedTuple


def build_payload() -> str:
    status = os.environ["STATUS"]
    delivery_id = os.environ.get("DELIVERY_ID_OVERRIDE", "").strip()
    event_type = os.environ.get("EVENT_TYPE_OVERRIDE", "").strip()

    if bool(delivery_id) != bool(event_type):
        sys.exit(
            "Error: Both 'delivery-id' and 'event-type' must be set together "
            "for nightly/periodic mode. Got delivery-id="
            f"{delivery_id!r}, event-type={event_type!r}"
        )

    is_self_report = bool(delivery_id and event_type)

    if is_self_report:
        if event_type not in ("nightly", "periodic"):
            sys.exit(
                f"Error: event-type must be 'nightly' or 'periodic', got {event_type!r}"
            )
        if status != "completed":
            sys.exit(
                f"Error: nightly/periodic callbacks require status 'completed', got {status!r}"
            )

    if status not in ("in_progress", "completed"):
        sys.exit(f"Error: status must be 'in_progress' or 'completed', got {status!r}")

    conclusion = os.environ.get("CONCLUSION", "").strip() or None
    if status == "in_progress":
        conclusion = None

    if is_self_report:
        client_payload = {
            "event_type": event_type,
            "delivery_id": delivery_id,
            "payload": {
                "repository": {"full_name": "pytorch/pytorch"},
                "head_sha": delivery_id,
            },
        }
    else:
        raw = os.environ.get("CLIENT_PAYLOAD", "null")
        try:
            client_payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            sys.exit(f"Error: CLIENT_PAYLOAD is not valid JSON: {exc}")

    current_time = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    check_run_id = os.environ.get("CHECK_RUN_ID", "").strip()
    if not check_run_id:
        check_run_id = f"{os.environ['RUN_ID']}-{os.environ['RUN_ATTEMPT']}"

    workflow = {
        "schema_version": str(os.environ["SCHEMA_VERSION"]),
        "status": status,
        "conclusion": conclusion,
        "name": os.environ["WORKFLOW_NAME"],
        "url": os.environ["WORKFLOW_URL"],
        "run_attempt": os.environ["RUN_ATTEMPT"],
        "job_name": os.environ["JOB_NAME"],
        "check_run_id": check_run_id,
        "run_id": str(os.environ["RUN_ID"]),
        "started_at": current_time
        if is_self_report
        else (None if status == "completed" else current_time),
        "completed_at": None if status == "in_progress" else current_time,
    }

    test_results = os.environ.get("TEST_RESULTS", "").strip()
    if test_results:
        try:
            workflow["test_results"] = json.loads(test_results)
        except json.JSONDecodeError as exc:
            sys.exit(f"Error: TEST_RESULTS is not valid JSON: {exc}")

    failed_tests_detail = os.environ.get("FAILED_TESTS_DETAIL", "").strip()
    if failed_tests_detail:
        try:
            parsed = json.loads(failed_tests_detail)
            if not isinstance(parsed, list):
                sys.exit("Error: FAILED_TESTS_DETAIL must be a JSON array")
            workflow["failed_tests_detail"] = parsed[:1000]
        except json.JSONDecodeError as exc:
            sys.exit(f"Error: FAILED_TESTS_DETAIL is not valid JSON: {exc}")

    triage_verdict = os.environ.get("TRIAGE_VERDICT", "").strip()
    if triage_verdict:
        try:
            parsed = json.loads(triage_verdict)
            if not isinstance(parsed, dict):
                raise ValueError("TRIAGE_VERDICT must be a JSON object")
            workflow["triage_verdict"] = parsed
        except (json.JSONDecodeError, ValueError) as exc:
            print(f"Warning: ignoring invalid TRIAGE_VERDICT: {exc}", file=sys.stderr)

    artifact_url = os.environ.get("ARTIFACT_URL", "").strip()
    if artifact_url:
        workflow["artifact_url"] = artifact_url

    client_payload["workflow"] = workflow
    return json.dumps(client_payload)


# The relay rate-limits per repo over a sliding 60 s window, so the backoff
# has to add up to about a minute for the last retry to land in a fresh window.
RATE_LIMIT_BACKOFF_S = (2, 4, 8, 16, 32)


class Response(NamedTuple):
    returncode: int  # curl exit code
    http_code: str
    body: str
    retry_after: int | None


def parse_retry_after(headers: str) -> int | None:
    """Seconds from a Retry-After header in curl's --dump-header output."""
    for line in headers.splitlines():
        name, _, value = line.partition(":")
        if name.strip().lower() == "retry-after":
            try:
                return int(value.strip())
            except ValueError:
                return None
    return None


def post_once(payload_file: str) -> Response:
    """POST the payload once."""
    with tempfile.TemporaryDirectory() as tmp:
        body_file = os.path.join(tmp, "body")
        header_file = os.path.join(tmp, "headers")
        result = subprocess.run(
            [
                "curl",
                "--silent",
                "--show-error",
                "--fail-with-body",
                "--output",
                body_file,
                "--dump-header",
                header_file,
                "--write-out",
                "%{http_code}",
                "-X",
                "POST",
                "--max-time",
                os.environ.get("MAX_TIME", "10"),
                "-H",
                "Content-Type: application/json",
                "-H",
                f"Authorization: Bearer {os.environ['OIDC_TOKEN']}",
                "--data",
                f"@{payload_file}",
                os.environ["CALLBACK_URL"].rstrip("/"),
            ],
            capture_output=True,
            text=True,
        )

        def read(path: str) -> str:
            try:
                with open(path) as f:
                    return f.read()
            except FileNotFoundError:
                return ""

        return Response(
            result.returncode,
            result.stdout.strip(),
            read(body_file),
            parse_retry_after(read(header_file)),
        )


def send_callback(payload: str) -> None:
    retries = int(os.environ.get("RATE_LIMIT_RETRIES", str(len(RATE_LIMIT_BACKOFF_S))))

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        f.write(payload)
        payload_file = f.name

    try:
        attempt = 0
        while True:
            resp = post_once(payload_file)
            # Only the relay's own rate limit sends Retry-After. A 429 that HUD
            # returned through the relay comes after the job state was written,
            # and a retry would fail as an invalid state transition.
            if (
                resp.http_code != "429"
                or resp.retry_after is None
                or attempt >= retries
            ):
                break
            delay = max(
                resp.retry_after,
                RATE_LIMIT_BACKOFF_S[min(attempt, len(RATE_LIMIT_BACKOFF_S) - 1)],
            )
            attempt += 1
            print(
                f"Relay rate limit hit (HTTP 429); retry {attempt}/{retries} "
                f"in {delay}s",
                file=sys.stderr,
            )
            time.sleep(delay)
    finally:
        os.unlink(payload_file)

    if resp.returncode != 0:
        print(
            f"Error: Callback server returned HTTP {resp.http_code}.", file=sys.stderr
        )
        if resp.body:
            print(f"Relay server error response body:\n{resp.body}", file=sys.stderr)
        sys.exit(resp.returncode)

    print(f"Relay server response HTTP: {resp.http_code}")


if __name__ == "__main__":
    payload = build_payload()
    send_callback(payload)
