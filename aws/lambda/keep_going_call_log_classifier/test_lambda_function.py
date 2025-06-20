import unittest
from unittest.mock import patch

from lambda_function import lambda_handler


def get_test_event(job_id: int) -> dict:
    return {
        "Records": [
            {
                "s3": {
                    "bucket": {
                        "name": "gha-artifacts"
                    },
                    "object": {
                        "key": f"temp_logs/{job_id}"
                    }
                }
            }
        ]
    }


class TestKeepGoingUploadCallLogClassifier(unittest.TestCase):
    def test_lambda_handler(self):
        # Mock urlopen to avoid actual HTTP requests
        # Check urlopen called with the expected URL
        expected_url = "https://vwg52br27lx5oymv4ouejwf4re0akoeg.lambda-url.us-east-1.on.aws/?job_id=123345&repo=pytorch/pytorch&temp_log=true"
        with patch('lambda_function.urlopen') as mock_urlopen:
            lambda_handler(get_test_event(123345), None)
            mock_urlopen.assert_called_once_with(expected_url)

    def test_fails_with_invalid_job_id(self):
        # Mock urlopen to avoid actual HTTP requests
        # Check urlopen called with the expected URL
        with patch('lambda_function.urlopen') as mock_urlopen:
            lambda_handler(get_test_event("not a number"), None)
            mock_urlopen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
