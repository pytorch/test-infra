import argparse
import datetime
import json
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Dict, List, NamedTuple

import requests
from setuptools import distutils  # type: ignore[import]
from torchci.check_alerts import (
    clear_alerts,
    close_if_too_many_comments,
    create_issue,
    fetch_alerts,
    update_issue,
)
from torchci.utils import get_hud_headers


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


class AWSAlertRule(NamedTuple):
    machine_regexes: list[str]
    rule: Callable[[int, int], bool]
    team: str


# Rules for alerts sent via the new AWS alerting system in
# https://github.com/pytorch/alerting-infra. Each machine gets its own alert
# even if it is the same rule
AWS_ALERT_RULES = [
    AWSAlertRule(
        machine_regexes=[
            ".*rocm.*",
        ],
        rule=lambda count, seconds: count > 20 and seconds > 1 * 60 * 60,
        team="rocm-queue",
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


@lru_cache
def get_queues() -> List[Dict[str, Any]]:
    # %7B%7D = encoded {}
    url = (
        "https://hud.pytorch.org/api/clickhouse/queued_jobs_by_label?parameters=%7B%7D"
    )
    response = requests.get(url, headers=get_hud_headers())
    response.raise_for_status()
    return response.json()


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
    response = get_queues()

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


class AWSAlert(NamedTuple):
    queue_info: QueueInfo
    alerting_rule: AWSAlertRule
    status: str  # "FIRING" or "RESOLVED"


def get_all_machines() -> list[str]:
    # %7B%7D = encoded {}
    url = "https://hud.pytorch.org/api/clickhouse/all_machine_types?parameters=%7B%7D"
    response = requests.get(url, headers=get_hud_headers())
    response.raise_for_status()
    machines = response.json()
    return [m["machine_type"] for m in machines]


def get_aws_alerts(
    queues: List[Dict[str, Any]],
    alert_rules: list[AWSAlertRule],
    all_machines: list[str],
) -> list[AWSAlert]:
    """
    Given a list of queues and alerting rules, return a list of AWSAlert objects
    representing the alerts that should be fired or resolved. This is only used
    by aws_queue_alert_system and is separated out from the main function to
    make it easier to test.
    """
    alerts = []
    machine_to_queue_map = {q["machine_type"]: q for q in queues}

    for alerting_rule in alert_rules:
        for machine in all_machines:
            if not any(
                re.match(regex, machine) for regex in alerting_rule.machine_regexes
            ):
                continue
            queue = machine_to_queue_map.get(machine)
            if queue is None or not alerting_rule.rule(
                queue["count"], queue["avg_queue_s"]
            ):
                # close the alert if it exists
                alerts.append(
                    AWSAlert(
                        queue_info=QueueInfo(machine, 0, 0),
                        alerting_rule=alerting_rule,
                        status="RESOLVED",
                    )
                )
                continue
            queue_info = QueueInfo(
                machine,
                queue["count"],
                queue["avg_queue_s"] / 3600,
            )
            print(
                f"Alerting rule {alerting_rule.team} matched machine {queue_info.machine} with {queue_info.count} in queue for {queue_info.hours} hours"
            )
            alerts.append(
                AWSAlert(
                    queue_info=queue_info,
                    alerting_rule=alerting_rule,
                    status="FIRING",
                )
            )

    return alerts


def aws_queue_alert_system(dry_run: bool) -> None:
    def send_to_aws_alerting_lambda(
        team: str,
        title: str,
        description: str,
        alarm_id: str,
        state: str,
        dry_run: bool,
    ) -> None:
        """Helper for sending alerts to the AWS alerting lambda function"""
        now = datetime.datetime.now(datetime.timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%S.%fZ"
        )
        alert = {
            "schema_version": 1,
            "source": "test-infra-queue-alerts",
            "state": state,
            "title": title,
            "description": description,
            "summary": description,
            "priority": "P2",
            "occurred_at": now,
            "teams": [team],
            "identity": {
                "alarm_id": f"queue_alert_{alarm_id}",
            },
            "links": {"dashboard_url": "https://hud.pytorch.org/metrics"},
        }

        data = json.dumps(alert).encode()
        headers = {
            "Content-Type": "application/json",
            "x-test-infra-queue-alerts-signature": os.environ[
                "QUEUE_ALERT_AWS_LAMBDA_TOKEN"
            ],
        }
        if dry_run:
            print(f"Dry run, not sending alert: {json.dumps(alert, indent=2)}")
            return
        requests.post(
            os.environ["AWS_INFRA_ALERTS_LAMBDA_URL"],
            data=data,
            headers=headers,
        )

    def get_alarm_id(team: str, machine: str) -> str:
        return f"{team}_{machine.replace('.', '_')}"

    # The title needs to be the same to close the alert
    def gen_title(machine: str) -> str:
        return f"[Pytorch] Machine {machine} has a long queue"

    alerts = get_aws_alerts(get_queues(), AWS_ALERT_RULES, get_all_machines())
    for alert in alerts:
        send_to_aws_alerting_lambda(
            team=alert.alerting_rule.team,
            title=gen_title(alert.queue_info.machine),
            description=f"Machine {alert.queue_info.machine} has {alert.queue_info.count} jobs in queue for {round(alert.queue_info.hours, 2)} hours",
            alarm_id=get_alarm_id(alert.alerting_rule.team, alert.queue_info.machine),
            state=alert.status,
            dry_run=dry_run,
        )


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
    aws_queue_alert_system(args.dry_run)
