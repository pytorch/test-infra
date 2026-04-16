import json
import unittest

from pytorch_auto_revert.testers.hud import default_hud_filename, get_state_timestamp


class HudHelperTests(unittest.TestCase):
    def test_default_hud_filename_sanitizes_colons_and_spaces(self):
        self.assertEqual(
            default_hud_filename("2025-09-22 18:59:14"),
            "2025-09-22_18-59-14.html",
        )

    def test_default_hud_filename_rejects_blank_input(self):
        with self.assertRaises(ValueError):
            default_hud_filename("   ")

    def test_get_state_timestamp_from_mapping(self):
        state = {"meta": {"ts": "2025-09-22T18:59:14"}}
        self.assertEqual(get_state_timestamp(state), "2025-09-22T18:59:14")

    def test_get_state_timestamp_from_json_string(self):
        state_json = json.dumps({"meta": {"ts": "2025-09-22T18:59:14"}})
        self.assertEqual(get_state_timestamp(state_json), "2025-09-22T18:59:14")

    def test_get_state_timestamp_missing_value(self):
        with self.assertRaises(ValueError):
            get_state_timestamp({"meta": {}})


if __name__ == "__main__":
    unittest.main()
