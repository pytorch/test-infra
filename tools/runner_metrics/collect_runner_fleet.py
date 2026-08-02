#!/usr/bin/env python3
"""Sample how many self-hosted runners are registered with a GitHub org,
bucketed by label, and write the counts as JSONEachRow for S3 -> ClickHouse
ingestion (misc.runner_fleet_count via clickhouse-replicator-s3).

A runner is counted under every tracked label it carries, so a host with both
``macos-m1-14`` and ``macos-m1-stable`` contributes to both series -- these are
distinct scheduling labels, which is what we want to trend.

The output is newline-delimited JSON (one object per line); each object's keys
match the ClickHouse column names exactly (JSONEachRow maps by name). The
workflow gzips this file and uploads it under the runner_fleet_count/ prefix.

Environment:
  GITHUB_TOKEN            token with org "self-hosted runners: read"
                          (fine-grained) or classic ``admin:org`` read scope.
  RUNNER_ORG              org to query (default: pytorch).
  TRACKED_LABEL_PREFIXES  comma-separated label prefixes to record
                          (default: "macos,linux.dgx.b200").
  OUTPUT_FILE             path to write JSONEachRow to (default:
                          runner_fleet_count.jsonl).
"""

from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

import requests


GITHUB_API = "https://api.github.com"


def list_org_runners(org: str, token: str) -> list[dict]:
    """Return every self-hosted runner registered with ``org`` (all pages)."""
    session = requests.Session()
    session.headers.update(
        {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
    )
    runners: list[dict] = []
    page = 1
    while True:
        resp = session.get(
            f"{GITHUB_API}/orgs/{org}/actions/runners",
            params={"per_page": 100, "page": page},
            timeout=30,
        )
        resp.raise_for_status()
        payload = resp.json()
        batch = payload.get("runners", [])
        runners.extend(batch)
        if not batch or len(runners) >= payload.get("total_count", 0):
            break
        page += 1
    return runners


def bucket_by_label(
    runners: list[dict], prefixes: list[str]
) -> dict[str, dict[str, int]]:
    counts: dict[str, dict[str, int]] = defaultdict(
        lambda: {"total": 0, "online": 0, "busy": 0}
    )
    for runner in runners:
        is_online = str(runner.get("status", "")).lower() == "online"
        is_busy = bool(runner.get("busy"))
        for name in {label.get("name", "") for label in runner.get("labels", [])}:
            if not any(name.startswith(p) for p in prefixes):
                continue
            counts[name]["total"] += 1
            counts[name]["online"] += int(is_online)
            counts[name]["busy"] += int(is_busy)
    return counts


def main() -> int:
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        print("GITHUB_TOKEN is required", file=sys.stderr)
        return 1
    org = os.environ.get("RUNNER_ORG", "pytorch")
    prefixes = [
        p.strip()
        for p in os.environ.get("TRACKED_LABEL_PREFIXES", "macos,linux.dgx.b200").split(
            ","
        )
        if p.strip()
    ]
    output_file = os.environ.get("OUTPUT_FILE", "runner_fleet_count.jsonl")

    runners = list_org_runners(org, token)
    counts = bucket_by_label(runners, prefixes)

    # ClickHouse DateTime64(0, 'UTC') parses this "YYYY-MM-DD HH:MM:SS" form.
    sample_ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    lines = []
    for label, c in sorted(counts.items()):
        row = {
            "time_stamp": sample_ts,
            "org": org,
            "label": label,
            "total_count": c["total"],
            "online_count": c["online"],
            "busy_count": c["busy"],
        }
        lines.append(json.dumps(row))
        print(
            f"{org} {label}: total={c['total']} online={c['online']} busy={c['busy']}"
        )

    if not lines:
        # An empty match set is a real (all-zero) observation, but we cannot
        # synthesize per-label zero rows without knowing every expected label.
        # Fail loudly rather than silently uploading an empty object.
        print(
            f"ERROR: no runners matched prefixes {prefixes} in org {org}.",
            file=sys.stderr,
        )
        return 2

    with open(output_file, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"Wrote {len(lines)} rows to {output_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
