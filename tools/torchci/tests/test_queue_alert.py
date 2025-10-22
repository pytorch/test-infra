from typing import Any, Dict
from unittest import main, TestCase

from torchci.queue_alert import filter_long_queues, gen_update_comment, QueueInfo


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


if __name__ == "__main__":
    main()
