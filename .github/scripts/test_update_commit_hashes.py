#!/usr/bin/env python3
import unittest
from unittest import mock

import update_commit_hashes as uch


class TestGetCommitDate(unittest.TestCase):
    def test_parses_timestamp_when_reachable(self):
        with mock.patch.object(uch, "_git_show_timestamp", return_value="1700000000"):
            self.assertEqual(uch._get_commit_date("repo", "abc"), 1700000000)

    def test_fetches_then_retries_when_missing_from_clone(self):
        # First `git show` comes up empty (hash not in the clone); after an
        # explicit fetch the retry succeeds.
        with mock.patch.object(
            uch, "_git_show_timestamp", side_effect=["", "1700000000"]
        ) as show, mock.patch.object(uch.subprocess, "run") as run:
            self.assertEqual(uch._get_commit_date("repo", "abc"), 1700000000)
            run.assert_called_once()
            self.assertEqual(show.call_count, 2)

    def test_returns_none_when_unresolvable(self):
        # Hash is orphaned upstream: neither the initial show nor the post-fetch
        # retry can read it.
        with mock.patch.object(
            uch, "_git_show_timestamp", side_effect=["", ""]
        ), mock.patch.object(uch.subprocess, "run"):
            self.assertIsNone(uch._get_commit_date("repo", "abc"))


class TestIsNewerHash(unittest.TestCase):
    def _patch_dates(self, new_date, old_date):
        # is_newer_hash queries the new hash first, then the old hash.
        return mock.patch.object(
            uch, "_get_commit_date", side_effect=[new_date, old_date]
        )

    def test_new_hash_is_newer(self):
        with self._patch_dates(200, 100):
            self.assertTrue(uch.is_newer_hash("new", "old", "repo"))

    def test_new_hash_is_not_newer(self):
        with self._patch_dates(100, 200):
            self.assertFalse(uch.is_newer_hash("new", "old", "repo"))

    def test_orphaned_old_hash_moves_pin_forward(self):
        # The old pin is unreachable (orphaned upstream) -> treat as an update
        # so the pin still advances instead of crashing.
        with self._patch_dates(200, None):
            self.assertTrue(uch.is_newer_hash("new", "old", "repo"))

    def test_unresolvable_new_hash_does_not_update(self):
        with self._patch_dates(None, 100):
            self.assertFalse(uch.is_newer_hash("new", "old", "repo"))


if __name__ == "__main__":
    unittest.main()
