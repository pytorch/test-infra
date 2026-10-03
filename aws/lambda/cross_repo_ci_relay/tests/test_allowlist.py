import unittest
from unittest.mock import MagicMock, patch

from utils.allowlist import (
    AllowlistLevel,
    AllowlistMap,
    CrcrEvent,
    DEFAULT_CRCR_EVENTS,
    load_allowlist,
    refresh_allowlist,
    SUPPORTED_CRCR_EVENTS,
)


@patch("utils.allowlist.redis_helper")
@patch("utils.allowlist._fetch", return_value="L3:\n  npu:\n    org/repo: [a]\n")
class TestLoadAllowlist(unittest.TestCase):
    def test_refresh_fetches_and_caches_whatever_the_cache_holds(self, fetch, redis):
        cfg = MagicMock()
        redis.get_cached_yaml.return_value = "L2:\n  - stale/repo\n"

        allowlist = refresh_allowlist(cfg)

        fetch.assert_called_once_with(cfg.allowlist_url)
        redis.set_cached_yaml.assert_called_once_with(cfg, fetch.return_value)
        self.assertEqual(allowlist.get_repo_level("org/repo"), AllowlistLevel.L3)
        self.assertIsNone(allowlist.get_repo_level("stale/repo"))

    def test_load_uses_the_cache_and_only_fetches_on_a_miss(self, fetch, redis):
        cfg = MagicMock()
        redis.get_cached_yaml.return_value = "L2:\n  - cached/repo\n"
        self.assertEqual(
            load_allowlist(cfg).get_repo_level("cached/repo"), AllowlistLevel.L2
        )
        fetch.assert_not_called()

        redis.get_cached_yaml.return_value = None
        self.assertEqual(
            load_allowlist(cfg).get_repo_level("org/repo"), AllowlistLevel.L3
        )
        fetch.assert_called_once()
        redis.set_cached_yaml.assert_called_once()


class TestAllowlistMap(unittest.TestCase):
    def _raw(self):
        return {
            "L1": ["a/1"],
            "L2": [],
            "L3": {
                "device1": {"b/device1-repo": ["oncall_b"]},
                "device2": {"b/device2-repo": []},
            },
            "L4": [{"c/3": "oncall_c"}],
        }

    def test_parse_and_get_repos_at_or_above_level(self):
        amap = AllowlistMap._parse(self._raw())
        repos, oncalls = amap.get_repos_at_or_above_level(AllowlistLevel.L1)
        self.assertEqual(
            sorted(repos), ["a/1", "b/device1-repo", "b/device2-repo", "c/3"]
        )
        self.assertEqual(oncalls, ["oncall_b", "oncall_c"])

    def test_get_repos_for_device(self):
        amap = AllowlistMap._parse(self._raw())
        repos, oncalls = amap.get_repos_for_device("device1")
        self.assertEqual(repos, ["b/device1-repo"])
        self.assertEqual(oncalls, ["oncall_b"])
        empty_repos, _ = amap.get_repos_for_device("unknown")
        self.assertEqual(empty_repos, [])

    def test_get_repo_device(self):
        amap = AllowlistMap._parse(self._raw())
        self.assertEqual(amap.get_repo_device("b/device1-repo"), "device1")
        self.assertEqual(amap.get_repo_device("b/device2-repo"), "device2")
        self.assertIsNone(amap.get_repo_device("a/1"))

    def test_default_events_are_supported(self):
        self.assertTrue(DEFAULT_CRCR_EVENTS <= SUPPORTED_CRCR_EVENTS)

    def test_legacy_entries_default_to_pull_request_and_nightly(self):
        amap = AllowlistMap._parse(self._raw())
        for repo in ("a/1", "b/device1-repo", "c/3"):
            self.assertEqual(
                amap.get_repo_events(repo),
                frozenset({CrcrEvent.PULL_REQUEST, CrcrEvent.NIGHTLY}),
            )

    def test_parse_entry_metadata(self):
        amap = AllowlistMap._parse(
            {
                "L2": [
                    {
                        "nightly/repo": {
                            "events": ["nightly"],
                            "oncalls": ["nightly-oncall"],
                        }
                    }
                ],
                "L3": {
                    "device": {
                        "pr/repo": {
                            "events": ["pull_request"],
                            "oncalls": "pr-oncall",
                        }
                    }
                },
            }
        )
        self.assertEqual(amap.get_repo_events("nightly/repo"), {CrcrEvent.NIGHTLY})
        self.assertEqual(amap.get_repo_events("pr/repo"), {CrcrEvent.PULL_REQUEST})
        _, oncalls = amap.get_level(AllowlistLevel.L2)
        self.assertEqual(oncalls, ["nightly-oncall"])
        self.assertEqual(
            amap.get_repos_for_device("device"), (["pr/repo"], ["pr-oncall"])
        )

    def test_invalid_event_metadata_raises(self):
        with self.assertRaisesRegex(RuntimeError, "unsupported event"):
            AllowlistMap._parse({"L2": [{"org/repo": {"events": ["push"]}}]})
        with self.assertRaisesRegex(RuntimeError, "unsupported metadata"):
            AllowlistMap._parse({"L2": [{"org/repo": {"owner": "team"}}]})

    def test_duplicate_repo_raises(self):
        with self.assertRaises(RuntimeError):
            AllowlistMap._parse({"L1": ["org/repo"], "L2": ["org/repo"]})

    def test_l3_non_dict_raises(self):
        with self.assertRaises(RuntimeError):
            AllowlistMap._parse({"L3": ["org/repo"]})


if __name__ == "__main__":
    unittest.main()
