import unittest

from allowlist import AllowlistLevel, AllowlistMap


class TestAllowlistMap(unittest.TestCase):
    def test_parse_and_get_from_level(self):
        raw = {
            "L1": ["a/1"],
            "L2": [],
            "L3": ["b/2"],
            "L4": [{"c/3": "oncall_c"}],
        }
        amap = AllowlistMap._parse(raw)
        repos, oncalls = amap.get_from_level(AllowlistLevel.L1)
        self.assertEqual(sorted(repos), ["a/1", "b/2", "c/3"])
        self.assertEqual(oncalls, ["oncall_c"])

    def test_duplicate_repo_raises(self):
        with self.assertRaises(RuntimeError):
            AllowlistMap._parse({"L1": ["org/repo"], "L2": ["org/repo"]})


if __name__ == "__main__":
    unittest.main()
