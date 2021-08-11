"""
This script pulls down dashboards from Grafana, matches them by name to their
correpsonding JSONs in files/dashboards, and sends a new commit to
pytorch/test-infra if anything has changed
"""

import os
import requests
import json
import difflib
from pathlib import Path
from typing import List, Dict, Any, Tuple

user = os.environ["GRAFANA_USER"]
password = os.environ["GRAFANA_PASSWORD"]

Dashboard = Dict[str, Any]

ROOT = Path(__file__).resolve().parent
DASHBOARD_DIR = ROOT / "files" / "dashboards"


def grafana(url):
    base = "https://metrics.pytorch.org/api"
    r = requests.get(f"{base}/{url.lstrip('/')}", auth=(user, password))
    value = r.json()
    if isinstance(value, dict) and value.get("message", None) is not None:
        raise RuntimeError(value)
    return value


def get_dashboards() -> List[Dashboard]:
    response = grafana("search?query=")
    return [item for item in response if item.get("type") == "dash-db"]


def files_by_uid() -> List[Dict[str, Any]]:
    paths = DASHBOARD_DIR.glob("*.json")
    files = {}
    for path in paths:
        with open(path) as f:
            dashboard = json.load(f)
            uid = dashboard["uid"]
            files[uid] = {"path": path, "dashboard": dashboard}
    return files


def diff(expected, actual):
    expected = expected.splitlines(1)
    actual = actual.splitlines(1)
    diff = difflib.unified_diff(expected, actual)
    return "".join(diff)


def file_path(name: str) -> str:
    name = name.replace(" ", "_").replace("-", "_")
    return f"{name}.json"


if __name__ == "__main__":
    dashboards = get_dashboards()
    files = files_by_uid()

    updated = False

    for dashboard in dashboards:
        uid = dashboard["uid"]
        dashboard_on_grafana = grafana(f"dashboards/uid/{uid}")["dashboard"]
        file = files.get(
            uid,
            {
                "dashboard": "doesn't exist",
                "path": file_path(dashboard_on_grafana["title"]),
            },
        )
        dashboard_in_repo = file["dashboard"]

        if dashboard_on_grafana == dashboard_in_repo:
            # They're the same, no need to update
            continue

        updated = True
        dashboard_on_grafana = json.dumps(dashboard_on_grafana, indent=2)
        dashboard_in_repo = json.dumps(dashboard_in_repo, indent=2)

        print(diff(dashboard_in_repo, dashboard_on_grafana))

        with open(file["path"], "w") as f:
            f.write(dashboard_on_grafana)

    if updated:
        print("::set-output name=UPDATED_DASHBOARDS::yes")
    else:
        print("::set-output name=UPDATED_DASHBOARDS::no")

