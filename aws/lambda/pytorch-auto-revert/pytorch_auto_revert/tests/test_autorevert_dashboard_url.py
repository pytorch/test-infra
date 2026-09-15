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
                signal_ids=["periodic-strict:test_signal"],
            ),
            "https://hud.pytorch.org/hud/pytorch/pytorch/main/autorevert"
            "?ar_ts=2026-09-15T00%3A02%3A34Z"
            "&ar_sha=0519eef7e2a6d24aba3db4d6f13aa0ee998c0d9f"
            "&ar_focus=1&ar_wf=periodic-strict"
            "&ar_sf=periodic-strict%3Atest_signal",
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

    def test_empty_filters_are_omitted(self):
        url = build_autorevert_dashboard_url(
            repo_full_name="pytorch/pytorch",
            ts=TS,
            commit_sha="abc123",
            workflows=[""],
            signal_ids=[],
        )
        self.assertNotIn("ar_wf", url)
        self.assertNotIn("ar_sf", url)

    def test_signal_ids_are_pipe_joined_and_escaped(self):
        # Signal keys carry commas, spaces and slashes; "|" is the ar_sf
        # separator, so it must survive as %7C and the rest must be escaped.
        url = build_autorevert_dashboard_url(
            repo_full_name="pytorch/pytorch",
            ts=TS,
            commit_sha="abc123",
            workflows=["trunk", "inductor"],
            signal_ids=["trunk:linux-jammy / test (default, 1, 2)", "trunk:ops.py"],
        )
        self.assertIn("&ar_wf=trunk%2Cinductor", url)
        self.assertIn(
            "&ar_sf=trunk%3Alinux-jammy%20%2F%20test%20%28default%2C%201%2C%202%29"
            "%7Ctrunk%3Aops.py",
            url,
        )

    def test_whole_filter_dropped_when_an_id_carries_the_separator(self):
        # A literal "|" would read as a term boundary. Keeping the other terms
        # would quietly hide the unrepresentable signal, so the filter goes.
        url = build_autorevert_dashboard_url(
            repo_full_name="pytorch/pytorch",
            ts=TS,
            commit_sha="abc123",
            signal_ids=["trunk:a|b", "trunk:c"],
        )
        self.assertNotIn("ar_sf", url)

    def test_signal_filter_kept_at_the_cutoff_and_dropped_one_char_past(self):
        def url_for(key_len: int) -> str:
            return build_autorevert_dashboard_url(
                repo_full_name="pytorch/pytorch",
                ts=TS,
                commit_sha="abc123",
                # "x" needs no escaping, so one key char is one URL char.
                signal_ids=["trunk:" + "x" * key_len],
            )

        pad = 1500 - len(url_for(1))
        at_cutoff = url_for(1 + pad)
        self.assertEqual(len(at_cutoff), 1500)
        self.assertIn("ar_sf", at_cutoff)
        self.assertNotIn("ar_sf", url_for(2 + pad))

    def test_signal_filter_dropped_when_url_would_be_too_long(self):
        many = [f"trunk:{'x' * 80}{i}" for i in range(40)]
        url = build_autorevert_dashboard_url(
            repo_full_name="pytorch/pytorch",
            ts=TS,
            commit_sha="abc123",
            workflows=["trunk"],
            signal_ids=many,
        )
        self.assertNotIn("ar_sf", url)
        # The coarser filters survive, so the link is still useful.
        self.assertIn("ar_focus=1", url)
        self.assertIn("ar_wf=trunk", url)
        self.assertLess(len(url), 1500)

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
