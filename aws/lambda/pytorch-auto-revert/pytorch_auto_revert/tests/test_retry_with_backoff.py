import sys
import unittest
from unittest.mock import call, patch


# Ensure package import when running from repo root
sys.path.insert(0, "aws/lambda/pytorch-auto-revert")

from pytorch_auto_revert.utils import RetryWithBackoff  # noqa: E402


def run_with_retry(op, **kwargs):
    """Helper mirroring how RetryWithBackoff is used in code.

    for attempt in RetryWithBackoff(...):
        with attempt:
            return op()
    """
    for attempt in RetryWithBackoff(**kwargs):
        with attempt:
            return op()


EX = ValueError("boom")


class UnstableOp:
    def __init__(self, fail_times: int, exc: Exception = EX):
        self.fail_times = fail_times
        self.calls = 0
        self.exc = exc

    def __call__(self):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise self.exc
        return 42


class TestRetryWithBackoff(unittest.TestCase):
    @patch("pytorch_auto_revert.utils.time.sleep")
    def test_success_first_try_no_sleep(self, sleep_mock):
        op = UnstableOp(fail_times=0)
        res = run_with_retry(op, max_retries=3, base_delay=0.1, jitter=False)
        self.assertEqual(res, 42)
        self.assertEqual(op.calls, 1)
        sleep_mock.assert_not_called()

    @patch("pytorch_auto_revert.utils.time.sleep")
    def test_eventual_success_after_retries(self, sleep_mock):
        op = UnstableOp(fail_times=2)
        res = run_with_retry(op, max_retries=5, base_delay=0.1, jitter=False)
        self.assertEqual(res, 42)
        self.assertEqual(op.calls, 3)
        # Backoff without jitter: 0.1, 0.2
        self.assertEqual(sleep_mock.call_args_list, [call(0.1), call(0.2)])

    @patch("pytorch_auto_revert.utils.time.sleep")
    def test_raises_after_max_retries(self, sleep_mock):
        op = UnstableOp(fail_times=10)
        with self.assertRaises(ValueError):
            run_with_retry(op, max_retries=3, base_delay=0.1, jitter=False)
        # Two sleeps for attempts 1 and 2; none after final failed attempt
        self.assertEqual(sleep_mock.call_args_list, [call(0.1), call(0.2)])
        self.assertEqual(op.calls, 3)

    @patch("pytorch_auto_revert.utils.random.uniform", side_effect=lambda a, b: b)
    @patch("pytorch_auto_revert.utils.time.sleep")
    def test_jitter_applied_to_backoff(self, sleep_mock, _uniform_mock):
        op = UnstableOp(fail_times=1)
        res = run_with_retry(op, max_retries=3, base_delay=0.2, jitter=True)
        self.assertEqual(res, 42)
        self.assertEqual(op.calls, 2)
        # With max jitter (10%), expected delay = 0.2 * (1 + 0.1) = 0.22
        # Allow tiny floating point drift
        self.assertEqual(len(sleep_mock.call_args_list), 1)
        self.assertAlmostEqual(sleep_mock.call_args_list[0].args[0], 0.22, places=6)


if __name__ == "__main__":
    unittest.main()
