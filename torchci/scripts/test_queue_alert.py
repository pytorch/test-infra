from queue_alert import filter_long_queues, gen_update_comment, QueueInfo
from unittest import main, TestCase


class TestGitHubPR(TestCase):
    def test_filter_long_queues(self):
        rockset_results = [
            {"count": 30, "avg_queue_s": 0, "machine_type": "linux.gcp.a100.large"},
            {"count": 100, "avg_queue_s": 0, "machine_type": "machine1"},
            {"count": 30, "avg_queue_s": 3600 * 5, "machine_type": "machine2"},
        ]
        long_queues = filter_long_queues(rockset_results)
        self.assertEqual(len(long_queues), 3)

        rockset_results = [
            {
                "count": 0,
                "avg_queue_s": 3600 * 30,
                "machine_type": "linux.gcp.a100.large",
            },
            {"count": 10, "avg_queue_s": 0, "machine_type": "machine1"},
            {"count": 10, "avg_queue_s": 3600 * 1, "machine_type": "machine2"},
        ]
        long_queues = filter_long_queues(rockset_results)
        self.assertEqual(len(long_queues), 1)
        self.assertEqual(long_queues[0].machine, "linux.gcp.a100.large")

    def test_gen_update_comment(self):
        original_issue = {"closed": True}
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
