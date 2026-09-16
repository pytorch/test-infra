import unittest
from datetime import datetime, timedelta, timezone

from pytorch_auto_revert.utils import (
    build_autorevert_dashboard_url,
    dashboard_anchor_ts,
)


TS = datetime(2026, 9, 15, 0, 2, 34, tzinfo=timezone.utc)


class DashboardAnchorTsTests(unittest.TestCase):
    """The comment prints this instant and the URL resolves on it — one source."""

    def test_naive_is_utc_and_sub_second_is_truncated(self):
        self.assertEqual(
            dashboard_anchor_ts(TS.replace(tzinfo=None, microsecond=999999)), TS
        )

    def test_offset_aware_input_keeps_its_instant(self):
        self.assertEqual(
            dashboard_anchor_ts(TS.astimezone(timezone(timedelta(hours=-7)))), TS
        )


class BuildAutorevertDashboardUrlTests(unittest.TestCase):
    def test_full_url(self):
        self.assertEqual(
            build_autorevert_dashboard_url(
                repo_full_name="pytorch/pytorch",
                ts=TS,
                commit_sha="0519eef7e2a6d24aba3db4d6f13aa0ee998c0d9f",
                workflows=["periodic-strict"],
            ),
            "https://hud.pytorch.org/hud/pytorch/pytorch/main/autorevert"
            "?ar_ts=2026-09-15T00%3A02%3A34Z"
            "&ar_sha=0519eef7e2a6d24aba3db4d6f13aa0ee998c0d9f"
            "&ar_focus=1&ar_wf=periodic-strict",
        )

    def test_no_per_signal_filter_is_emitted(self):
        # ar_focus does the column narrowing and ar_sha marks the suspect.
        self.assertNotIn(
            "ar_sf",
            build_autorevert_dashboard_url(
                repo_full_name="pytorch/pytorch",
                ts=TS,
                commit_sha="abc123",
                workflows=["trunk"],
            ),
        )

    def test_naive_timestamp_is_read_as_utc(self):
        self.assertIn(
            "ar_ts=2026-09-15T00%3A02%3A34Z",
            build_autorevert_dashboard_url(
                repo_full_name="pytorch/pytorch",
                ts=TS.replace(tzinfo=None),
                commit_sha="abc123",
            ),
        )

    def test_non_utc_timestamp_is_converted(self):
        self.assertIn(
            "ar_ts=2026-09-15T00%3A02%3A34Z",
            build_autorevert_dashboard_url(
                repo_full_name="pytorch/pytorch",
                ts=TS.astimezone(timezone(timedelta(hours=-7))),
                commit_sha="abc123",
            ),
        )

    def test_sub_second_timestamp_is_truncated_like_the_writer(self):
        # The snapshot row stores int(ts.timestamp()) in a second-precision
        # DateTime column, and the query is `ts <= target`: truncating the same
        # way keeps the run's own snapshot on the matching side.
        self.assertIn(
            "ar_ts=2026-09-15T00%3A02%3A34Z",
            build_autorevert_dashboard_url(
                repo_full_name="pytorch/pytorch",
                ts=TS.replace(microsecond=999999),
                commit_sha="abc123",
            ),
        )

    def test_empty_workflow_filter_is_omitted(self):
        self.assertNotIn(
            "ar_wf",
            build_autorevert_dashboard_url(
                repo_full_name="pytorch/pytorch",
                ts=TS,
                commit_sha="abc123",
                workflows=[""],
            ),
        )

    def test_workflows_are_comma_joined_and_escaped(self):
        self.assertIn(
            "&ar_wf=trunk%2Cinductor",
            build_autorevert_dashboard_url(
                repo_full_name="pytorch/pytorch",
                ts=TS,
                commit_sha="abc123",
                workflows=["trunk", "inductor"],
            ),
        )

    def test_branch_stays_one_path_segment(self):
        self.assertIn(
            "/hud/pytorch/pytorch/release%2F2.9/autorevert?",
            build_autorevert_dashboard_url(
                repo_full_name="pytorch/pytorch",
                ts=TS,
                commit_sha="abc123",
                branch="release/2.9",
            ),
        )


if __name__ == "__main__":
    unittest.main()
