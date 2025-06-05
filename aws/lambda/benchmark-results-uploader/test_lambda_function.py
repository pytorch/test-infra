import os
import unittest
import json
from unittest.mock import patch
from botocore.exceptions import ClientError
from lambda_function import (
    lambda_handler,
    check_path_exists,
    upload_to_s3,
    authenticate,
)


class TestBenchmarkResultsUploader(unittest.TestCase):
    def setUp(self):
        # Set up test environment variables
        os.environ["AUTH_USERNAME"] = "test_user"
        os.environ["AUTH_PASSWORD"] = "test_password"

        # Test event with valid credentials
        self.valid_event = {
            "username": "test_user",
            "password": "test_password",
            "bucket_name": "test-bucket",
            "path": "test/path.json",
            "content": '{"test": "data"}',
        }

        # Test event with invalid credentials
        self.invalid_auth_event = {
            "username": "wrong_user",
            "password": "wrong_password",
            "bucket_name": "test-bucket",
            "path": "test/path.json",
            "content": '{"test": "data"}',
        }

        # Test event missing required fields
        self.incomplete_event = {
            "username": "test_user",
            "password": "test_password",
            "bucket_name": "test-bucket",
        }

    @patch("lambda_function.authenticate")
    def test_authentication_failure(self, mock_authenticate):
        mock_authenticate.return_value = False
        response = lambda_handler(self.invalid_auth_event, {})
        self.assertEqual(response["statusCode"], 403)
        self.assertIn(
            "Invalid authentication credentials",
            json.loads(response["body"])["message"],
        )

    @patch("lambda_function.authenticate")
    @patch("lambda_function.check_path_exists")
    @patch("lambda_function.upload_to_s3")
    def test_successful_upload(
        self, mock_upload_to_s3, mock_check_path_exists, mock_authenticate
    ):
        mock_authenticate.return_value = True
        mock_check_path_exists.return_value = False

        expected_response = {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "message": "File uploaded successfully to test-bucket/test/path.json",
                    "etag": "test-etag",
                }
            ),
        }
        mock_upload_to_s3.return_value = expected_response

        response = lambda_handler(self.valid_event, {})
        self.assertEqual(response["statusCode"], 200)
        mock_upload_to_s3.assert_called_once_with(
            "test-bucket", "test/path.json", '{"test": "data"}'
        )

    @patch("lambda_function.authenticate")
    @patch("lambda_function.check_path_exists")
    def test_path_already_exists(self, mock_check_path_exists, mock_authenticate):
        mock_authenticate.return_value = True
        mock_check_path_exists.return_value = True

        response = lambda_handler(self.valid_event, {})
        self.assertEqual(response["statusCode"], 409)
        self.assertIn("already exists", json.loads(response["body"])["message"])

    @patch("lambda_function.authenticate")
    def test_missing_parameters(self, mock_authenticate):
        mock_authenticate.return_value = True

        response = lambda_handler(self.incomplete_event, {})
        self.assertEqual(response["statusCode"], 400)
        self.assertIn(
            "Missing required parameter", json.loads(response["body"])["message"]
        )

    @patch("lambda_function.s3_client")
    def test_check_path_exists_true(self, mock_s3_client):
        mock_s3_client.head_object.return_value = {}
        self.assertTrue(check_path_exists("test-bucket", "test/path.json"))

    @patch("lambda_function.s3_client")
    def test_check_path_exists_false(self, mock_s3_client):
        error_response = {"Error": {"Code": "404"}}
        mock_s3_client.head_object.side_effect = ClientError(
            error_response, "HeadObject"
        )
        self.assertFalse(check_path_exists("test-bucket", "test/path.json"))

    @patch("lambda_function.s3_client")
    def test_upload_to_s3_success(self, mock_s3_client):
        mock_s3_client.put_object.return_value = {"ETag": "test-etag"}
        response = upload_to_s3("test-bucket", "test/path.json", '{"test": "data"}')
        self.assertEqual(response["statusCode"], 200)
        body = json.loads(response["body"])
        self.assertIn("File uploaded successfully", body["message"])
        self.assertEqual(body["etag"], "test-etag")

    @patch("lambda_function.s3_client")
    def test_upload_to_s3_failure(self, mock_s3_client):
        mock_s3_client.put_object.side_effect = Exception("Test error")
        response = upload_to_s3("test-bucket", "test/path.json", '{"test": "data"}')
        self.assertEqual(response["statusCode"], 500)
        self.assertIn("Error uploading file", json.loads(response["body"])["message"])

    def test_authenticate(self):
        self.assertTrue(authenticate("test_user", "test_password"))
        self.assertFalse(authenticate("wrong_user", "test_password"))
        self.assertFalse(authenticate("test_user", "wrong_password"))


if __name__ == "__main__":
    unittest.main()
