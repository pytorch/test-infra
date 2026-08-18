#!/usr/bin/env python3
"""Fetch vLLM Buildkite CI failure reports for a given branch."""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from dataclasses import dataclass, field
from typing import Any, Optional


ORG = "vllm"
PIPELINE = "ci"
API_BASE = f"https://api.buildkite.com/v2/organizations/{ORG}/pipelines/{PIPELINE}"
PUBLIC_BASE = f"https://buildkite.com/{ORG}/{PIPELINE}"

Failure = tuple[str, str]


@dataclass
class FailedStep:
    label: str
    job_id: str
    log_url: str = ""
    raw_log: str = ""
    local_log_path: str = ""
    failures: list[Failure] = field(default_factory=list)


@dataclass
class BuildInfo:
    number: int
    state: str
    message: str
    branch: str
    created_at: str
    failed_steps: list[FailedStep] = field(default_factory=list)


def _request(url: str, token: Optional[str] = None, max_retries: int = 3) -> Any:
    cmd = ["curl", "-s"]
    if token:
        cmd += ["-H", f"Authorization: Bearer {token}"]
    cmd.append(url)
    for _ in range(max_retries):
        r = subprocess.run(cmd, capture_output=True, text=True)
        try:
            data = json.loads(r.stdout)
        except json.JSONDecodeError:
            return None
        if isinstance(data, dict) and "rate limit" in data.get("message", ""):
            time.sleep(6)
            continue
        return data
    return None


def get_latest_build(branch: str, token: str) -> Optional[BuildInfo]:
    """Step 1: Get the latest build for a branch."""
    branch_enc = branch.replace(":", "%3A")
    url = f"{API_BASE}/builds?branch={branch_enc}&per_page=1"
    data = _request(url, token=token)
    if not data or not isinstance(data, list) or len(data) == 0:
        return None
    b = data[0]
    return BuildInfo(
        number=b["number"],
        state=b["state"],
        message=b["message"].split("\n")[0],
        branch=b["branch"],
        created_at=b["created_at"],
    )


def get_failed_steps(build_number: int) -> list[FailedStep]:
    """Step 2: Get all failed command steps and their job IDs."""
    url = f"{PUBLIC_BASE}/builds/{build_number}/data/steps?state=failed"
    data = _request(url)
    if not data or not isinstance(data, list):
        return []
    steps = []
    for step in data:
        if step.get("type") == "command" and step.get("outcome") == "hard_failed":
            job_id = step.get("statistics", {}).get("latest_job_id", "")
            log_url = f"{PUBLIC_BASE}/builds/{build_number}#{job_id}"
            steps.append(
                FailedStep(label=step["label"], job_id=job_id, log_url=log_url)
            )
    return steps


def get_failure_reasons(
    build_number: int, job_id: str, token: str
) -> tuple[list[Failure], str]:
    """Step 3: Fetch a job's log and extract failure reasons.

    Returns (failures, raw_log).
    """
    url = f"{API_BASE}/builds/{build_number}/jobs/{job_id}/log"
    time.sleep(1.5)
    data = _request(url, token=token)
    if not data or not isinstance(data, dict):
        return [("Could not fetch log", "")], ""
    content = data.get("content", "")
    lines = content.split("\n")

    log_url = f"{PUBLIC_BASE}/builds/{build_number}#{job_id}"
    failures: list[Failure] = []
    for line_num, line in enumerate(lines, 1):
        clean = re.sub(r"\x1b\[[0-9;]*m", "", line)
        clean = re.sub(r"_bk;t=\d+\s*", "", clean)
        clean = re.sub(r"\[\d{4}-\d{2}-\d{2}T[\d:Z]+\]\s*", "", clean)
        if "FAILED" in clean and "::" in clean:
            parts = clean.split(" - ", 1)
            test = parts[0].replace("FAILED ", "").strip()
            err = parts[1].strip() if len(parts) > 1 else ""
            link = f"{log_url}/L{line_num}"
            entry = f"{test} | {err}" if err else test
            failures.append((entry, link))
        elif "ERROR: No matching distribution" in clean:
            link = f"{log_url}/L{line_num}"
            failures.append((clean.strip()[:200], link))
    return failures, content


def fetch_failure_report(branch: str, token: str) -> Optional[BuildInfo]:
    """Run the full pipeline: latest build -> failed steps -> failure reasons."""
    build = get_latest_build(branch, token)
    if not build:
        print(f"No builds found for branch '{branch}'")
        return None

    build.failed_steps = get_failed_steps(build.number)

    for step in build.failed_steps:
        step.failures, step.raw_log = get_failure_reasons(
            build.number, step.job_id, token
        )

    return build


def save_logs(build: BuildInfo, output_dir: str) -> None:
    """Save raw logs for each failed step to local files."""
    log_dir = os.path.join(output_dir, f"build_{build.number}")
    os.makedirs(log_dir, exist_ok=True)
    for step in build.failed_steps:
        if not step.raw_log:
            continue
        safe_label = re.sub(r"[^\w\- ]", "", step.label).strip().replace(" ", "_")
        path = os.path.abspath(os.path.join(log_dir, f"{safe_label}.log"))
        with open(path, "w") as f:
            f.write(step.raw_log)
        step.local_log_path = path
    print(f"Logs saved to {log_dir}/")


def print_report(build: BuildInfo) -> None:
    """Print a formatted failure report."""
    print("=" * 70)
    print(f"Build #{build.number} | Branch: {build.branch} | State: {build.state}")
    print(f"Message: {build.message}")
    print(f"Created: {build.created_at}")
    print(f"Failed steps: {len(build.failed_steps)}")
    print("=" * 70)

    for i, step in enumerate(build.failed_steps, 1):
        print(f"\n  {i}. [{step.label}]")
        print(f"    Log: {step.log_url}")
        if step.local_log_path:
            print(f"    Local: {step.local_log_path}")
        if step.failures:
            for entry, link in step.failures:
                print(f"    - {entry}")
                print(f"      {link}")
        else:
            print("    (no specific test failures extracted)")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Fetch vLLM Buildkite CI failures")
    parser.add_argument(
        "--branch",
        required=True,
        help="Branch name, e.g. atalman:release_212_tests",
    )
    parser.add_argument("--token", required=True, help="Buildkite API token")
    parser.add_argument(
        "--save-local-logs",
        action="store_true",
        help="Save raw logs to local files",
    )
    parser.add_argument(
        "--output-dir",
        default=".",
        help="Directory for saved logs (default: current dir)",
    )
    args = parser.parse_args()

    build = fetch_failure_report(args.branch, args.token)
    if build:
        if args.save_local_logs:
            save_logs(build, args.output_dir)
        print_report(build)
