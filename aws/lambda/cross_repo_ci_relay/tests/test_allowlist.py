import unittest

from utils.allowlist import AllowlistLevel, AllowlistMap


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

    def test_duplicate_repo_raises(self):
        with self.assertRaises(RuntimeError):
            AllowlistMap._parse({"L1": ["org/repo"], "L2": ["org/repo"]})

    def test_l3_non_dict_raises(self):
        with self.assertRaises(RuntimeError):
            AllowlistMap._parse({"L3": ["org/repo"]})


if __name__ == "__main__":
    unittest.main()
