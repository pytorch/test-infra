import argparse
import os
import re
from pathlib import Path
from typing import Any, Dict, List, NamedTuple

import requests
from setuptools import distutils  # type: ignore[import]
from torchci.check_alerts import (
    clear_alerts,
    close_if_too_many_comments,
    create_issue,
    fake_browser_headers,
    fetch_alerts,
    update_issue,
)


REPO_ROOT = Path(__file__).resolve().parent.parent.parent

QUEUE_ALERT_LABEL = "queue-alert"

RULES = [
    (
        # rocm machines: >50 in queue for >2 hours
        lambda machine_type: "rocm" in machine_type,
        lambda count, seconds: count > 50 and seconds > 2 * 60 * 60,
    ),
    (
        # common linux machines: >50 in queue for >30 minutes
        lambda machine_type: "linux.2xlarge" or "linux.4xlarge" in machine_type,
        lambda count, seconds: count > 50 and seconds > 30 * 60,
    ),
    (
        # all other machines: >50 in queue for >1 hour
        lambda _: True,
        lambda count, seconds: count > 50 and seconds > 60 * 60,
    ),
]


class QueueInfo(NamedTuple):
    machine: str
    count: int
    hours: float


def gen_queue_info_str(q: QueueInfo) -> str:
    return f"- {q.machine}, {q.count} machines, {round(q.hours, 2)} hours\n"


def gen_update_comment(original_issue: Any, new_queues: List[QueueInfo]) -> str:
    original_machines = []
    if not original_issue["closed"]:
        original_body = original_issue["body"]
        for line in original_body.splitlines():
            match = re.match(r"^- (.*), .* machines, .* hours$", line.strip())
            if match is not None:
                original_machines.append(match.group(1))

    started_queueing = [q for q in new_queues if q.machine not in original_machines]

    s = ""
    if len(started_queueing) > 0:
        s += "These machines started queueing:\n"
        for q in started_queueing:
            s += gen_queue_info_str(q)
        s += "\n"
    return s.rstrip()


def gen_issue(queues: List[QueueInfo]) -> Any:
    queues.sort(key=lambda q: q.machine)
    body = "Within the last 5 minutes, these machines had long queues (exact numbers may be out of date):\n"
    for q in queues:
        body += gen_queue_info_str(q)
    body += "\nPlease look at the hud metrics page for more info."

    issue = {}
    issue["title"] = f"[Pytorch] There are {len(queues)} machines with long queues"
    issue["body"] = body
    issue["labels"] = [QUEUE_ALERT_LABEL]
    issue["state"] = "open"

    return issue


def filter_long_queues(db_result: List[Dict[str, Any]]) -> List[QueueInfo]:
    large_queue: List[QueueInfo] = []

    for result in db_result:
        avg_queue_s, count, machine_type = (
            result["avg_queue_s"],
            result["count"],
            result["machine_type"],
        )

        for condition, action in RULES:
            if condition(machine_type):
                if action(count, avg_queue_s):
                    queue_info = QueueInfo(machine_type, count, avg_queue_s / 3600)
                    large_queue.append(queue_info)
                break

    return large_queue


def queuing_alert(dry_run: bool) -> None:
    # %7B%7D = encoded {}
    url = (
        "https://hud.pytorch.org/api/clickhouse/queued_jobs_by_label?parameters=%7B%7D"
    )
    response = requests.get(url, headers=fake_browser_headers())
    print(response.status_code)
    print(response.text)
    response = response.json()

    large_queue = filter_long_queues(response)

    existing_alerts = fetch_alerts([QUEUE_ALERT_LABEL])

    if len(large_queue) == 0:
        print("Closing queuing alert")
        clear_alerts(existing_alerts, dry_run=dry_run)
        return

    existing_alerts = [
        x for x in existing_alerts if not close_if_too_many_comments(x, dry_run)
    ]

    if len(existing_alerts) == 0:
        # Generate a blank issue if there are no issues with the label and
        # re-fetch the issues so we can post an update comment, which will
        # trigger a more informative workchat ping
        new_issue = create_issue(gen_issue([]), dry_run)
        existing_alerts.append(new_issue)

    # Favor the most recent issue and close the rest
    existing_issue = existing_alerts[-1]
    clear_alerts(existing_alerts[:-1], dry_run)

    update_comment = gen_update_comment(existing_issue, large_queue)

    if update_comment:
        new_issue = gen_issue(large_queue)
        update_issue(new_issue, existing_issue, update_comment, dry_run=dry_run)
    else:
        print("No new change for queuing alert")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dry-run",
        type=distutils.util.strtobool,
        default=os.getenv("DRY_RUN", "YES"),
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    queuing_alert(args.dry_run)
