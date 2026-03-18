import unittest

from torchci.test_insights.daily_regression import (
    get_name_in_info_anywhere_link,
    name_in_info_anywhere,
)


class DailyRegressionHelpers(unittest.TestCase):
    def test_name_in_info_anywhere(self):
        search_string = "search_string"
        info = {
            "short_job_name": "test_job",
            "file": "file",
            "labels": [
                "some_label",
            ],
        }
        self.assertFalse(name_in_info_anywhere(info, search_string))
        has_label = {
            **info,
            "labels": [
                "some_label",
                "this_label_has_search_string_inside",
            ],
        }
        self.assertTrue(name_in_info_anywhere(has_label, search_string))

        has_job = {
            **info,
            "short_job_name": "this_job_has_search_string_inside",
        }
        self.assertTrue(name_in_info_anywhere(has_job, search_string))
        has_test = {
            **info,
            "file": "path/to/the/search_string_file.py",
        }
        self.assertTrue(name_in_info_anywhere(has_test, search_string))

    def test_get_name_in_info_anywhere_link(self):
        search_string = "search_string"
        url = get_name_in_info_anywhere_link(search_string)
        expected_url = (
            "https://hud.pytorch.org/tests/fileReport?"
            f"label={search_string}&"
            f"job={search_string}&"
            f"file={search_string}&"
            "labelRegex=true&"
            "jobRegex=true&"
            "fileRegex=true&"
            "useOrFilter=true"
        )
        self.assertEqual(url, expected_url)


if __name__ == "__main__":
    unittest.main()
