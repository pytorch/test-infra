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
    ARTIFACT_URL            URL to downstream artifacts
    MAX_TIME                curl --max-time (default 10)
"""

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone


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
            sys.exit(f"Error: event-type must be 'nightly' or 'periodic', got {event_type!r}")
        if status != "completed":
            sys.exit(f"Error: nightly/periodic callbacks require status 'completed', got {status!r}")

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
        "started_at": None if status == "completed" else current_time,
        "completed_at": None if status == "in_progress" else current_time,
    }

    test_results = os.environ.get("TEST_RESULTS", "").strip()
    if test_results:
        try:
            workflow["test_results"] = json.loads(test_results)
        except json.JSONDecodeError as exc:
            sys.exit(f"Error: TEST_RESULTS is not valid JSON: {exc}")

    artifact_url = os.environ.get("ARTIFACT_URL", "").strip()
    if artifact_url:
        workflow["artifact_url"] = artifact_url

    client_payload["workflow"] = workflow
    return json.dumps(client_payload)


def send_callback(payload: str) -> None:
    callback_url = os.environ["CALLBACK_URL"].rstrip("/")
    oidc_token = os.environ["OIDC_TOKEN"]
    max_time = os.environ.get("MAX_TIME", "10")

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        f.write(payload)
        payload_file = f.name

    try:
        result = subprocess.run(
            [
                "curl",
                "--silent",
                "--show-error",
                "--fail-with-body",
                "--output",
                "/tmp/relay_response.json",
                "--write-out",
                "%{http_code}",
                "-X",
                "POST",
                "--max-time",
                max_time,
                "-H",
                "Content-Type: application/json",
                "-H",
                f"Authorization: Bearer {oidc_token}",
                "--data",
                f"@{payload_file}",
                callback_url,
            ],
            capture_output=True,
            text=True,
        )
    finally:
        os.unlink(payload_file)

    http_code = result.stdout.strip()
    if result.returncode != 0:
        print(f"Error: Callback server returned HTTP {http_code}.", file=sys.stderr)
        try:
            with open("/tmp/relay_response.json") as f:
                body = f.read()
            if body:
                print(f"Relay server error response body:\n{body}", file=sys.stderr)
        except FileNotFoundError:
            pass
        sys.exit(result.returncode)

    print(f"Relay server response HTTP: {http_code}")


if __name__ == "__main__":
    payload = build_payload()
    send_callback(payload)
