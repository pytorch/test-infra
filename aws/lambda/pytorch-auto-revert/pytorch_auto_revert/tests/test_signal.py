import unittest
from datetime import datetime, timedelta

from pytorch_auto_revert.signal import Signal, SignalCommit, SignalEvent, SignalStatus


def ts(base: datetime, minutes: int) -> datetime:
    return base + timedelta(minutes=minutes)


class TestSignal(unittest.TestCase):
    def setUp(self) -> None:
        self.t0 = datetime(2025, 8, 19, 12, 0, 0)

    def _ev(self, name: str, status: SignalStatus, minute: int) -> SignalEvent:
        return SignalEvent(name=name, status=status, started_at=ts(self.t0, minute))

    def test_detect_recovered_first_non_pending_success(self):
        # Newest commit has success (even with pending present) -> recovered
        c_new = SignalCommit(
            head_sha="new",
            events=[
                self._ev("job", SignalStatus.PENDING, 1),
                self._ev("job", SignalStatus.SUCCESS, 2),
            ],
        )
        c_old = SignalCommit(
            head_sha="old",
            events=[self._ev("job", SignalStatus.FAILURE, 1)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_new, c_old])
        self.assertTrue(s.detect_recovered())

    def test_detect_recovered_false_when_first_non_pending_failure(self):
        # Newest commit only has failure (no success)
        c_new = SignalCommit(
            head_sha="new",
            events=[self._ev("job", SignalStatus.FAILURE, 1)],
        )
        c_old = SignalCommit(
            head_sha="old",
            events=[self._ev("job", SignalStatus.SUCCESS, 1)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_new, c_old])
        self.assertFalse(s.detect_recovered())

    def test_detect_recovered_skips_all_pending_then_success(self):
        # First commit is all pending; next has success -> recovered
        c_new = SignalCommit(
            head_sha="new",
            events=[self._ev("job", SignalStatus.PENDING, 1)],
        )
        c_mid = SignalCommit(
            head_sha="mid",
            events=[self._ev("job", SignalStatus.SUCCESS, 1)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_new, c_mid])
        self.assertTrue(s.detect_recovered())

    def test_detect_flaky_true_on_same_commit_success_and_failure(self):
        c = SignalCommit(
            head_sha="sha",
            events=[
                self._ev("job", SignalStatus.SUCCESS, 1),
                self._ev("job", SignalStatus.FAILURE, 2),
            ],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c])
        self.assertTrue(s.detect_flaky())

    def test_detect_flaky_false_when_separate_commits(self):
        c_new = SignalCommit(
            head_sha="new",
            events=[self._ev("job", SignalStatus.SUCCESS, 1)],
        )
        c_old = SignalCommit(
            head_sha="old",
            events=[self._ev("job", SignalStatus.FAILURE, 1)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_new, c_old])
        self.assertFalse(s.detect_flaky())

    def test_confirm_not_an_infra_issue_true_on_sandwich(self):
        # Older commit has two successes at t=10 and t=30
        # Newer commit has a failure at t=20 (between) -> True
        c_new = SignalCommit(
            head_sha="new",
            events=[self._ev("job", SignalStatus.FAILURE, 20)],
        )
        c_old = SignalCommit(
            head_sha="old",
            events=[
                self._ev("job", SignalStatus.SUCCESS, 10),
                self._ev("job", SignalStatus.SUCCESS, 30),
            ],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_new, c_old])
        self.assertIs(s.confirm_not_an_infra_issue(), True)

    def test_confirm_not_an_infra_issue_none_with_pending_between(self):
        # Older has two successes; newer has pending between -> Maybe (None)
        c_new = SignalCommit(
            head_sha="new",
            events=[self._ev("job", SignalStatus.PENDING, 20)],
        )
        c_old = SignalCommit(
            head_sha="old",
            events=[
                self._ev("job", SignalStatus.SUCCESS, 10),
                self._ev("job", SignalStatus.SUCCESS, 30),
            ],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_new, c_old])
        self.assertIsNone(s.confirm_not_an_infra_issue())

    def test_confirm_not_an_infra_issue_false_when_pending_outside_window(self):
        # Older has two successes; newer has pending outside the [oldest, newest] success window -> False
        c_new = SignalCommit(
            head_sha="new",
            events=[self._ev("job", SignalStatus.PENDING, 35)],
        )
        c_old = SignalCommit(
            head_sha="old",
            events=[
                self._ev("job", SignalStatus.SUCCESS, 10),
                self._ev("job", SignalStatus.SUCCESS, 30),
            ],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_new, c_old])
        self.assertIs(s.confirm_not_an_infra_issue(), False)

    def test_confirm_not_an_infra_issue_false_no_bracketing_success(self):
        # Older has one success (t=10) and then pending to t=30; newer failure at t=40
        # Not within bracketing window -> False (and no maybe)
        c_new = SignalCommit(
            head_sha="new",
            events=[self._ev("job", SignalStatus.FAILURE, 40)],
        )
        c_old = SignalCommit(
            head_sha="old",
            events=[
                self._ev("job", SignalStatus.SUCCESS, 10),
                self._ev("job", SignalStatus.PENDING, 20),
                self._ev("job", SignalStatus.PENDING, 30),
            ],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c_new, c_old])
        self.assertIs(s.confirm_not_an_infra_issue(), False)

    def test_detect_autorevert_pattern_basic(self):
        # Commits newest -> older
        c_newer = SignalCommit(
            head_sha="sha_newer",
            events=[self._ev("job", SignalStatus.FAILURE, 5)],
        )
        c_suspected = SignalCommit(
            head_sha="sha_mid",
            events=[self._ev("job", SignalStatus.FAILURE, 4)],
        )
        c_base = SignalCommit(
            head_sha="sha_old",
            events=[self._ev("job", SignalStatus.SUCCESS, 3)],
        )
        s = Signal(
            key="job", workflow_name="wf", commits=[c_newer, c_suspected, c_base]
        )
        pat = s.detect_autorevert_pattern()
        self.assertIsNotNone(pat)
        self.assertEqual(pat.workflow_name, "wf")
        self.assertEqual(pat.newer_commits, ["sha_newer", "sha_mid"])
        self.assertEqual(pat.older_commit, "sha_old")

    def test_detect_autorevert_pattern_none_when_missing_failure(self):
        c_newer = SignalCommit(
            head_sha="sha_newer",
            events=[self._ev("job", SignalStatus.SUCCESS, 5)],
        )
        c_suspected = SignalCommit(
            head_sha="sha_mid",
            events=[self._ev("job", SignalStatus.FAILURE, 4)],
        )
        c_base = SignalCommit(
            head_sha="sha_old",
            events=[self._ev("job", SignalStatus.SUCCESS, 3)],
        )
        s = Signal(
            key="job", workflow_name="wf", commits=[c_newer, c_suspected, c_base]
        )
        self.assertIsNone(s.detect_autorevert_pattern())

    def test_has_loose_autorevert_pattern_true(self):
        # Order newest -> older; two failures first, then a success older
        c1 = SignalCommit(
            head_sha="sha1",
            events=[self._ev("job", SignalStatus.FAILURE, 5)],
        )
        c2 = SignalCommit(
            head_sha="sha2",
            events=[self._ev("job", SignalStatus.FAILURE, 4)],
        )
        c3 = SignalCommit(
            head_sha="sha3",
            events=[self._ev("job", SignalStatus.SUCCESS, 3)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c1, c2, c3])
        self.assertTrue(s.has_loose_autorevert_pattern())

    def test_has_loose_autorevert_pattern_false_when_success_before_two_failures(self):
        # Success encountered before counting 2 failures (in newest->older order)
        c1 = SignalCommit(
            head_sha="sha1",
            events=[self._ev("job", SignalStatus.FAILURE, 5)],
        )
        c2 = SignalCommit(
            head_sha="sha2",
            events=[self._ev("job", SignalStatus.SUCCESS, 4)],
        )
        c3 = SignalCommit(
            head_sha="sha3",
            events=[self._ev("job", SignalStatus.FAILURE, 3)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c1, c2, c3])
        self.assertFalse(s.has_loose_autorevert_pattern())

    def test_has_loose_autorevert_pattern_false_when_only_one_failure(self):
        c1 = SignalCommit(
            head_sha="sha1",
            events=[self._ev("job", SignalStatus.FAILURE, 5)],
        )
        c2 = SignalCommit(
            head_sha="sha2",
            events=[self._ev("job", SignalStatus.SUCCESS, 4)],
        )
        c3 = SignalCommit(
            head_sha="sha3",
            events=[self._ev("job", SignalStatus.SUCCESS, 3)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c1, c2, c3])
        self.assertFalse(s.has_loose_autorevert_pattern())

    def test_has_loose_autorevert_pattern_ignores_pending_only_commits(self):
        # Newest->older: failure, pending-only, failure, success(older) => True
        c1 = SignalCommit(
            head_sha="sha1",
            events=[self._ev("job", SignalStatus.FAILURE, 6)],
        )
        c2 = SignalCommit(
            head_sha="sha2",
            events=[self._ev("job", SignalStatus.PENDING, 5)],
        )
        c3 = SignalCommit(
            head_sha="sha3",
            events=[self._ev("job", SignalStatus.FAILURE, 4)],
        )
        c4 = SignalCommit(
            head_sha="sha4",
            events=[self._ev("job", SignalStatus.SUCCESS, 3)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c1, c2, c3, c4])
        self.assertTrue(s.has_loose_autorevert_pattern())

    def test_has_loose_autorevert_pattern_ignores_empty_event_commits(self):
        # Newest->older: failure, <empty>, failure, success(older) => True
        c1 = SignalCommit(
            head_sha="sha1",
            events=[self._ev("job", SignalStatus.FAILURE, 6)],
        )
        c2 = SignalCommit(head_sha="sha_empty", events=[])
        c3 = SignalCommit(
            head_sha="sha3",
            events=[self._ev("job", SignalStatus.FAILURE, 4)],
        )
        c4 = SignalCommit(
            head_sha="sha4",
            events=[self._ev("job", SignalStatus.SUCCESS, 3)],
        )
        s = Signal(key="job", workflow_name="wf", commits=[c1, c2, c3, c4])
        self.assertTrue(s.has_loose_autorevert_pattern())


if __name__ == "__main__":
    unittest.main()
