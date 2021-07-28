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

token = os.environ["GRAFANA_TOKEN"]

Dashboard = Dict[str, Any]

ROOT = Path(__file__).resolve().parent
DASHBOARD_DIR = ROOT / "files" / "dashboards"


def grafana(url):
    base = "https://metrics.pytorch.org/api"
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(f"{base}/{url.lstrip('/')}", headers=headers)
    return r.json()


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


if __name__ == "__main__":
    dashboards = get_dashboards()
    files = files_by_uid()

    updated = False

    for dashboard in dashboards:
        uid = dashboard["uid"]
        file = files[uid]
        dashboard_on_grafana = grafana(f"dashboards/uid/{uid}")["dashboard"]
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
        print('::set-output name=UPDATED_DASHBOARDS::yes')
    else:
        print('::set-output name=UPDATED_DASHBOARDS::no')
    

