#!/usr/bin/env python3

import argparse
import os
from typing import Any, Dict, List

import requests
from setuptools import distutils  # type: ignore[import]
from torchci.check_alerts import (
    clear_alerts,
    create_issue,
    fetch_alerts,
    update_issue,
)
from torchci.utils import get_hud_headers


LIVE_RUNNERS_ALERT_LABEL = "live-runners-alert"
ALLOWED_ORGS = ["pytorch"]
LIVE_RUNNERS_RULES = [
    {
        "runner_label": "linux.aws.a100",
        "threshold": 12,
    },
    {
        "runner_label": "linux.aws.h100",
        "threshold": 12,
    },
    {
        "runner_label": "linux.aws.h100.4",
        "threshold": 2,
    },
    {
        "runner_label": "linux.aws.h100.8",
        "threshold": 1,
    },
    {
        "runner_label": "macos-m1-stable",
        "threshold": 45,
    },
    {
        "runner_label": "macos-m2-stable",
        "threshold": 15,
    },
]


def fetch_data() -> List[Dict[str, Any]]:
    """Fetch runner data from HUD API for all allowed orgs."""
    all_runners = []
    for org in ALLOWED_ORGS:
        url = f"https://hud.pytorch.org/api/runners/{org}"
        response = requests.get(url, headers=get_hud_headers())
        response.raise_for_status()
        data = response.json()
        # data has {"groups": [...], "totalRunners": N}
        for group in data.get("groups", []):
            group["org"] = org
            all_runners.append(group)
    return all_runners


def get_alerting_items(data: List[Dict[str, Any]]) -> List[str]:
    """Return list of alerting item descriptions based on LIVE_RUNNERS_RULES."""
    alerts = []
    for group in data:
        label = group.get("label", "")
        for rule in LIVE_RUNNERS_RULES:
            if rule["runner_label"] == label:
                # Live runners = idle + busy (online runners)
                live_count = group.get("idleCount", 0) + group.get("busyCount", 0)
                if live_count < rule["threshold"]:
                    org = group.get("org", "unknown")
                    alerts.append(
                        f"{org}/{label}: {live_count} live runners "
                        f"(threshold: {rule['threshold']})"
                    )
    return alerts


def gen_issue(items: List[str]) -> Dict[str, Any]:
    body = "The following runner issues have been detected:\n"
    for item in items:
        body += f"- {item}\n"
    body += "[IMPORTANT DISCLAIMER] To avoid spamming, "
    body += "the issue will only be updated if title changes. This "
    body += "means that the CURRENT number of runners for each "
    body += "runner type might not be updated in the issue body, this number"
    body += " could have increased or decreased since firing.\n"
    return {
        "title": f"[Pytorch] Live Runners Alert - {len(items)} issue(s)",
        "body": body,
        "labels": [LIVE_RUNNERS_ALERT_LABEL],
        "state": "open",
    }


def gen_clean_issue() -> Dict[str, Any]:
    return {
        "title": f"[Pytorch] Live Runners Alert - Cleared all issues",
        "body": "All live runners issues have been cleared.",
        "labels": [LIVE_RUNNERS_ALERT_LABEL],
        "state": "closed",
    }


def print_alerting_items(items: List[str]) -> None:
    if not items:
        print("No alerting items found.")
        return

    print("Alerting items:")
    for item in items:
        print(f"- {item}")


def check_live_runners_alert(dry_run: bool) -> None:
    data = fetch_data()
    alerting_items = get_alerting_items(data)
    existing_alerts = fetch_alerts([LIVE_RUNNERS_ALERT_LABEL])

    print_alerting_items(alerting_items)

    if not alerting_items:
        clear_alerts(existing_alerts, dry_run)
        if existing_alerts and not existing_alerts[-1]["closed"]:
            new_issue = gen_clean_issue()
            update_issue(new_issue, existing_alerts[-1], "All live runners issues have been cleared.", dry_run)
        return

    if not existing_alerts:
        existing_alerts.append(create_issue(gen_issue([]), dry_run))       

    new_issue = gen_issue(alerting_items)
    existing_issue = existing_alerts[-1]

    if existing_issue["title"] == new_issue["title"]:
        print(f"No new change for live runners alert. Not updating any alert.")
        return

    clear_alerts(existing_alerts[:-1], dry_run)
    update_issue(new_issue, existing_issue, "\n".join(alerting_items), dry_run)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dry-run",
        type=distutils.util.strtobool,
        default=os.getenv("DRY_RUN", "YES"),
    )
    args = parser.parse_args()
    check_live_runners_alert(args.dry_run)
