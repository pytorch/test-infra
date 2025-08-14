import json
import unittest
from unittest.mock import patch

from lambda_function import (
    lambda_handler,
    save_agent_event,
    save_build_event,
    save_job_event,
)


class TestBuildkiteWebhookHandler(unittest.TestCase):
    def setUp(self):
        # Sample agent event
        self.agent_event = {
            "event": "agent.connected",
            "agent": {
                "id": "test-agent-123",
                "name": "test-agent",
                "hostname": "test-host",
            },
        }

        # Sample build event
        self.build_event = {
            "event": "build.finished",
            "build": {"number": 123, "branch": "main", "state": "passed"},
            "pipeline": {
                "repository": "https://github.com/test/repo",
                "name": "test-pipeline",
            },
        }

        # Sample job event
        self.job_event = {
            "event": "job.finished",
            "job": {"id": "test-job-456", "name": "test-job", "state": "passed"},
            "pipeline": {"repository": "https://github.com/test/repo"},
        }

        # Lambda event with body
        self.lambda_event_with_body = {"body": json.dumps(self.build_event)}

        # Lambda event without body (direct invocation)
        self.lambda_event_direct = self.build_event

    @patch("lambda_function.agent_events_table")
    def test_save_agent_event_success(self, mock_table):
        mock_table.put_item.return_value = {}

        response = save_agent_event(self.agent_event)

        self.assertEqual(response["statusCode"], 200)
        body = json.loads(response["body"])
        self.assertIn("Agent event saved successfully", body["message"])
        self.assertIn("test-agent-123", body["message"])

        mock_table.put_item.assert_called_once()
        call_args = mock_table.put_item.call_args[1]
        self.assertEqual(call_args["Item"]["dynamoKey"], "test-agent-123")

    @patch("lambda_function.agent_events_table")
    def test_save_agent_event_missing_id(self, mock_table):
        event_without_id = {"event": "agent.connected", "agent": {"name": "test-agent"}}

        response = save_agent_event(event_without_id)

        self.assertEqual(response["statusCode"], 400)
        body = json.loads(response["body"])
        self.assertEqual(body["message"], "Missing agent ID")
        mock_table.put_item.assert_not_called()

    @patch("lambda_function.agent_events_table")
    def test_save_agent_event_dynamodb_error(self, mock_table):
        from botocore.exceptions import ClientError

        mock_table.put_item.side_effect = ClientError(
            {"Error": {"Code": "ValidationException", "Message": "Test error"}},
            "PutItem",
        )

        response = save_agent_event(self.agent_event)

        self.assertEqual(response["statusCode"], 500)
        body = json.loads(response["body"])
        self.assertIn("DynamoDB error", body["message"])

    @patch("lambda_function.build_events_table")
    def test_save_build_event_success(self, mock_table):
        mock_table.put_item.return_value = {}

        response = save_build_event(self.build_event)

        self.assertEqual(response["statusCode"], 200)
        body = json.loads(response["body"])
        self.assertIn("Build event saved successfully", body["message"])
        self.assertIn("repo/test-pipeline/123", body["message"])

        mock_table.put_item.assert_called_once()
        call_args = mock_table.put_item.call_args[1]
        self.assertEqual(call_args["Item"]["dynamoKey"], "repo/test-pipeline/123")

    @patch("lambda_function.build_events_table")
    def test_save_build_event_missing_data(self, mock_table):
        event_without_build_number = {
            "event": "build.finished",
            "build": {"branch": "main"},
            "pipeline": {
                "repository": "https://github.com/test/repo",
                "name": "test-pipeline",
            },
        }

        response = save_build_event(event_without_build_number)

        self.assertEqual(response["statusCode"], 400)
        body = json.loads(response["body"])
        self.assertEqual(body["message"], "Missing repository name or build number")
        mock_table.put_item.assert_not_called()

    @patch("lambda_function.job_events_table")
    def test_save_job_event_success(self, mock_table):
        mock_table.put_item.return_value = {}

        response = save_job_event(self.job_event)

        self.assertEqual(response["statusCode"], 200)
        body = json.loads(response["body"])
        self.assertIn("Job event saved successfully", body["message"])
        self.assertIn("repo/test-job-456", body["message"])

        mock_table.put_item.assert_called_once()
        call_args = mock_table.put_item.call_args[1]
        self.assertEqual(call_args["Item"]["dynamoKey"], "repo/test-job-456")

    @patch("lambda_function.job_events_table")
    def test_save_job_event_missing_data(self, mock_table):
        event_without_job_id = {
            "event": "job.finished",
            "job": {"name": "test-job"},
            "pipeline": {"repository": "https://github.com/test/repo"},
        }

        response = save_job_event(event_without_job_id)

        self.assertEqual(response["statusCode"], 400)
        body = json.loads(response["body"])
        self.assertEqual(body["message"], "Missing repository name or job ID")
        mock_table.put_item.assert_not_called()

    @patch("lambda_function.save_build_event")
    def test_lambda_handler_with_body(self, mock_save_build):
        mock_save_build.return_value = {
            "statusCode": 200,
            "body": json.dumps({"message": "Success"}),
        }

        response = lambda_handler(self.lambda_event_with_body, {})

        self.assertEqual(response["statusCode"], 200)
        mock_save_build.assert_called_once_with(self.build_event)

    @patch("lambda_function.save_build_event")
    def test_lambda_handler_direct_event(self, mock_save_build):
        mock_save_build.return_value = {
            "statusCode": 200,
            "body": json.dumps({"message": "Success"}),
        }

        response = lambda_handler(self.lambda_event_direct, {})

        self.assertEqual(response["statusCode"], 200)
        mock_save_build.assert_called_once_with(self.build_event)

    @patch("lambda_function.save_agent_event")
    def test_lambda_handler_agent_event(self, mock_save_agent):
        agent_lambda_event = {"body": json.dumps(self.agent_event)}
        mock_save_agent.return_value = {
            "statusCode": 200,
            "body": json.dumps({"message": "Success"}),
        }

        response = lambda_handler(agent_lambda_event, {})

        self.assertEqual(response["statusCode"], 200)
        mock_save_agent.assert_called_once_with(self.agent_event)

    @patch("lambda_function.save_job_event")
    def test_lambda_handler_job_event(self, mock_save_job):
        job_lambda_event = {"body": json.dumps(self.job_event)}
        mock_save_job.return_value = {
            "statusCode": 200,
            "body": json.dumps({"message": "Success"}),
        }

        response = lambda_handler(job_lambda_event, {})

        self.assertEqual(response["statusCode"], 200)
        mock_save_job.assert_called_once_with(self.job_event)

    def test_lambda_handler_missing_event_type(self):
        event_without_type = {"body": json.dumps({"some": "data"})}

        response = lambda_handler(event_without_type, {})

        self.assertEqual(response["statusCode"], 400)
        body = json.loads(response["body"])
        self.assertEqual(body["message"], "Missing event type in webhook payload")

    def test_lambda_handler_unsupported_event_type(self):
        unsupported_event = {"body": json.dumps({"event": "unsupported.event"})}

        response = lambda_handler(unsupported_event, {})

        self.assertEqual(response["statusCode"], 400)
        body = json.loads(response["body"])
        self.assertEqual(body["message"], "Unsupported event type: unsupported.event")

    def test_lambda_handler_invalid_json(self):
        invalid_json_event = {"body": "invalid json"}

        response = lambda_handler(invalid_json_event, {})

        self.assertEqual(response["statusCode"], 400)
        body = json.loads(response["body"])
        self.assertIn("Invalid JSON payload", body["message"])

    @patch("lambda_function.save_build_event")
    def test_lambda_handler_unexpected_error(self, mock_save_build):
        mock_save_build.side_effect = Exception("Unexpected error")

        response = lambda_handler({"body": json.dumps(self.build_event)}, {})

        self.assertEqual(response["statusCode"], 500)
        body = json.loads(response["body"])
        self.assertIn("Unexpected error", body["message"])


if __name__ == "__main__":
    unittest.main()
