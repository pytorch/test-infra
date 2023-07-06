import json
from datetime import datetime
from unittest import main, TestCase
from unittest.mock import patch

from no_flaky_tests_alert import (
    generate_no_flaky_tests_issue,
    handle_flaky_tests_alert,
)

def mock_fetch_alerts(*args, **kwargs):
    """
    Return the mock JSON response when trying to fetch all existing alerts
    """

    class MockResponse:
        def __init__(self, json_data, status_code):
            self.text = json_data
            self.status_code = status_code

        def raise_for_status(self):
            pass

    response = {
        "data": {
            "repository": {
                "issues": {
                    "nodes": [
                        {
                            "title": "[Pytorch] There are 3 Recurrently Failing Jobs on pytorch/pytorch main",
                            "closed": False,
                            "number": 3763,
                            "body": "",
                            "comments": {"nodes": []},
                        },
                        {
                            "title": "[Pytorch] There are 3 Recurrently Failing Jobs on pytorch/pytorch nightly",
                            "closed": False,
                            "number": 3764,
                            "body": "",
                            "comments": {"nodes": []},
                        },
                    ]
                }
            }
        }
    }
    return MockResponse(json.dumps(response), 200)


class TestGitHubPR(TestCase):
    def test_generate_no_flaky_tests_issue(self):
        issue = generate_no_flaky_tests_issue()
        self.assertListEqual(issue["labels"], ["no-flaky-tests-alert"])

    @patch("no_flaky_tests_alert.create_issue")
    @patch("no_flaky_tests_alert.datetime")
    @patch("no_flaky_tests_alert.get_num_issues_with_label")
    def test_handle_flaky_tests_alert(
        self, mock_get_num_issues_with_label, mock_date, mock_create_issue
    ):
        mock_issue = {
            "title": "dummy-title",
            "labels": ["dummy-label"],
        }
        mock_create_issue.return_value = mock_issue
        mock_date.today.return_value = datetime(2022, 10, 10)
        mock_get_num_issues_with_label.return_value = 5

        res = handle_flaky_tests_alert([])
        self.assertIsNone(res)

        existing_alerts = [
            {"createdAt": "2022-10-10T13:41:09Z"},
            {"createdAt": "2022-10-08T14:41:09Z"},
        ]
        res = handle_flaky_tests_alert(existing_alerts)
        self.assertIsNone(res)

        existing_alerts = [
            {"createdAt": "2022-10-09T13:41:09Z"},
            {"createdAt": "2022-10-08T14:41:09Z"},
        ]
        res = handle_flaky_tests_alert(existing_alerts)
        self.assertIsNone(res)

        mock_get_num_issues_with_label.return_value = 0
        res = handle_flaky_tests_alert(existing_alerts)
        self.assertDictEqual(res, mock_issue)


if __name__ == "__main__":
    main()
