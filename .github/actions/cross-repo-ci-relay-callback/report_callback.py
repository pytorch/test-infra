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

A late report (EVENT_TYPE_OVERRIDE="late-report") adds triage verdicts to rows
reported earlier, for several jobs at once. It needs only OIDC_TOKEN, CALLBACK_URL
and TRIAGE_VERDICT_LIST, a JSON array (or "@path" to a file holding one) of
{delivery_id, workflow_name, job_name, check_run_id?, triage_verdict}. Nothing is
taken from the job running this script.

Optional env vars:
    CONCLUSION              Job conclusion (required when STATUS=completed)
    CLIENT_PAYLOAD          JSON string of the dispatch payload (PR/push mode)
    DELIVERY_ID_OVERRIDE    Upstream commit SHA (nightly/periodic self-report)
    EVENT_TYPE_OVERRIDE     "nightly" or "periodic" (self-report), or "late-report"
    CHECK_RUN_ID            GitHub check run ID (falls back to RUN_ID-RUN_ATTEMPT)
    TEST_RESULTS            JSON string with test result summary
    TRIAGE_VERDICT          JSON object with a triage verdict for this job
    TRIAGE_VERDICT_LIST     JSON array of reports (or "@path") for a late report
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


LATE_REPORT_EVENT_TYPE = "late-report"
# Reports per request (the relay accepts up to 100).
LATE_REPORT_CHUNK = 50
# HUD does a write per report, so allow more than a plain callback's default.
LATE_REPORT_MIN_MAX_TIME = 60


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


def read_late_reports() -> list:
    """The reports of a late report, from TRIAGE_VERDICT_LIST.

    A JSON array, or "@path" to a file holding one (an environment value is capped
    at about 128 KB). The relay checks each report's fields.
    """
    raw = os.environ.get("TRIAGE_VERDICT_LIST", "").strip()
    if not raw:
        sys.exit(
            "Error: event-type 'late-report' needs 'triage-verdict-list': a JSON "
            "array of reports, or @path to a file holding one"
        )
    if raw.startswith("@"):
        path = raw[1:].strip()
        try:
            with open(path) as f:
                raw = f.read()
        except OSError as exc:
            sys.exit(f"Error: cannot read the triage-verdict-list file {path!r}: {exc}")
    try:
        reports = json.loads(raw)
    except json.JSONDecodeError as exc:
        sys.exit(f"Error: triage-verdict-list is not valid JSON: {exc}")
    if not isinstance(reports, list):
        sys.exit("Error: triage-verdict-list must be a JSON array")
    for index, entry in enumerate(reports):
        if not isinstance(entry, dict):
            sys.exit(f"Error: triage-verdict-list[{index}] must be an object")
    return reports


def build_late_report_payloads() -> list[str]:
    """One request body per LATE_REPORT_CHUNK reports; none when there are none."""
    reports = read_late_reports()
    return [
        json.dumps(
            {
                "event_type": LATE_REPORT_EVENT_TYPE,
                "reports": reports[start : start + LATE_REPORT_CHUNK],
            }
        )
        for start in range(0, len(reports), LATE_REPORT_CHUNK)
    ]


def summarize_late_results(bodies: list[str], sent: list[int]) -> bool:
    """Print what happened to each report. False when any ended in an error.

    ``sent[i]`` is how many reports request ``i`` carried. A missing or unfinished
    row is only a warning, as is a request answered for fewer reports than it
    carried (the relay answers 200 when HUD is down). An existing verdict is fine:
    sending a report again is safe.
    """
    counts: dict[str, int] = {}
    ok = True
    for body, expected in zip(bodies, sent):
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            data = {}
        if data.get("status") == "ignored":
            print(
                "::warning::The relay ignored the late report: "
                "this repo is not allowlisted for CRCR."
            )
            counts["ignored"] = counts.get("ignored", 0) + 1
        answered = data.get("results") or []
        if data.get("status") != "ignored" and len(answered) < expected:
            print(
                f"::warning::The relay answered for {len(answered)} "
                f"of {expected} reports (HUD may be unavailable); "
                "send the list again."
            )
            counts["unanswered"] = (
                counts.get("unanswered", 0) + expected - len(answered)
            )
        for report in answered:
            result = str(report.get("result", "unknown"))
            counts[result] = counts.get(result, 0) + 1
            label = f"{report.get('job_name')} ({report.get('delivery_id')})"
            if result == "attached":
                print(f"  attached             {label}")
            elif result == "already_has_verdict":
                print(f"  already has a verdict {label}")
            elif result == "error":
                print(f"::error::The late report failed for {label}.")
                ok = False
            else:
                print(f"::warning::{result}: {label}")
    summary = ", ".join(f"{n} {name}" for name, n in sorted(counts.items()))
    print(f"Late report: {summary or 'nothing to report'}")
    return ok


def late_report_main() -> None:
    payloads = build_late_report_payloads()
    if not payloads:
        print("Late report: no reports to send.")
        return
    configured = float(os.environ.get("MAX_TIME", "10") or "10")
    os.environ["MAX_TIME"] = str(max(configured, LATE_REPORT_MIN_MAX_TIME))
    bodies = [send_callback(payload).body for payload in payloads]
    sent = [len(json.loads(payload)["reports"]) for payload in payloads]
    if not summarize_late_results(bodies, sent):
        sys.exit(1)


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


def send_callback(payload: str) -> Response:
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
    return resp


def main() -> None:
    if os.environ.get("EVENT_TYPE_OVERRIDE", "").strip() == LATE_REPORT_EVENT_TYPE:
        late_report_main()
        return
    if os.environ.get("TRIAGE_VERDICT_LIST", "").strip():
        # Not sending a list the caller handed over would lose every verdict in it.
        sys.exit(
            "Error: 'triage-verdict-list' is only used with event-type "
            f"'{LATE_REPORT_EVENT_TYPE}'"
        )
    send_callback(build_payload())


if __name__ == "__main__":
    main()
