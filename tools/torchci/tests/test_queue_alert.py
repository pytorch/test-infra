from typing import Any, Dict
from unittest import main, TestCase

from torchci.queue_alert import (
    AWSAlertRule,
    filter_long_queues,
    gen_update_comment,
    get_aws_alerts,
    QueueInfo,
)


class TestGitHubPR(TestCase):
    def test_filter_long_queues(self):
        db_results = [
            {"count": 100, "avg_queue_s": 7201, "machine_type": "rocm long"},
            {"count": 10, "avg_queue_s": 7201, "machine_type": "rocm few"},
            {"count": 100, "avg_queue_s": 1, "machine_type": "rocm short"},
            {"count": 100, "avg_queue_s": 3601, "machine_type": "machine1"},
            {"count": 10, "avg_queue_s": 3601, "machine_type": "machine1 few"},
            {"count": 100, "avg_queue_s": 1, "machine_type": "machine1 show"},
            {"count": 100, "avg_queue_s": 1801, "machine_type": "linux.2xlarge"},
            {
                "count": 10,
                "avg_queue_s": 1801,
                "machine_type": "linux.2xlarge few",
            },
            {"count": 100, "avg_queue_s": 1, "machine_type": "linux.2xlarge short"},
        ]
        long_queues = filter_long_queues(db_results)
        self.assertEqual(len(long_queues), 3)

        self.assertSetEqual(
            set(q.machine for q in long_queues),
            {"rocm long", "machine1", "linux.2xlarge"},
        )

    def test_gen_update_comment(self):
        original_issue: Dict[str, Any] = {"closed": True}  # type: ignore[annotation-unchecked]
        new_queues = [
            QueueInfo("machine1", 1, 2),
            QueueInfo("machine2", 2, 3),
        ]
        comment = gen_update_comment(original_issue, new_queues)
        self.assertTrue("- machine1, 1 machines, 2 hours" in comment)
        self.assertTrue("- machine2, 2 machines, 3 hours" in comment)

        original_issue = {"closed": False, "body": "- machine2, 2 machines, 3 hours"}
        new_queues = [
            QueueInfo("machine1", 1, 2),
            QueueInfo("machine2", 2, 3),
        ]
        comment = gen_update_comment(original_issue, new_queues)
        self.assertTrue("- machine1, 1 machines, 2 hours" in comment)
        self.assertTrue("- machine2, 2 machines, 3 hours" not in comment)


class TestAWSAlert(TestCase):
    def create_queue_row(
        self, count: int, avg_queue_s: int, machine_type: str
    ) -> Dict[str, Any]:
        # Helper function to create a queue row dict for testing
        return {
            "count": count,
            "avg_queue_s": avg_queue_s,
            "machine_type": machine_type,
        }

    def test_filter_aws_alerts(self):
        # Test that the correct alerts are generated based on the rules and
        # queue data, including resolved alerts and 1 rule with multiple machine
        db_results = [
            self.create_queue_row(1, 1, "machine1"),
            self.create_queue_row(2, 2, "machine2"),
            self.create_queue_row(3, 3, "machine3"),
        ]

        rules = [
            AWSAlertRule(
                machines=["machine1", "machine2"],
                rule=lambda count, seconds: count > 1 and seconds > 1,
                team="team1",
            ),
            AWSAlertRule(
                machines=["machine3"],
                rule=lambda count, seconds: count > 2 and seconds > 2,
                team="team2",
            ),
        ]

        alerts = get_aws_alerts(db_results, rules)
        self.assertEqual(len(alerts), 3)
        alerts.sort(key=lambda a: a.queue_info.machine)
        self.assertEqual(alerts[0].status, "RESOLVED")
        self.assertEqual(alerts[0].queue_info.machine, "machine1")
        self.assertEqual(alerts[0].alerting_rule.team, "team1")
        self.assertEqual(alerts[1].status, "FIRING")
        self.assertEqual(alerts[2].status, "FIRING")

    def test_filter_aws_alerts_(self):
        # Two teams listed for the same machine, both should get an alert if the
        # rule is satisfied

        db_results = [
            self.create_queue_row(1, 1, "machine1"),
        ]

        rules = [
            AWSAlertRule(
                machines=["machine1"],
                rule=lambda count, seconds: count > 0 and seconds > 0,
                team="team1",
            ),
            AWSAlertRule(
                machines=["machine1"],
                rule=lambda count, seconds: count > 0 and seconds > 0,
                team="team2",
            ),
        ]

        alerts = get_aws_alerts(db_results, rules)
        self.assertEqual(len(alerts), 2)


if __name__ == "__main__":
    main()
