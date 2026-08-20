import json
import unittest
from unittest.mock import patch

from lambda_function import classifier_payload, lambda_handler, parse_key


def s3_event(*keys: str) -> dict:
    return {
        "Records": [
            {
                "s3": {
                    "bucket": {"name": "ossci-raw-job-status"},
                    "object": {"key": key},
                }
            }
            for key in keys
        ]
    }


class TestParseKey(unittest.TestCase):
    def test_bare_id_is_pytorch_pytorch(self):
        self.assertEqual(parse_key("log/123345"), ("pytorch/pytorch", 123345))

    def test_prefixed_key_names_its_repo(self):
        self.assertEqual(
            parse_key("log/pytorch/executorch/999"), ("pytorch/executorch", 999)
        )

    def test_meta_pytorch_repo(self):
        self.assertEqual(
            parse_key("log/meta-pytorch/torchcomms/42"), ("meta-pytorch/torchcomms", 42)
        )

    def test_ignores_other_prefixes(self):
        # The notification is filtered to `log/`, but `classification/` and
        # `logs_something/` must not be mistaken for it if that ever changes.
        self.assertIsNone(parse_key("classification/123"))
        self.assertIsNone(parse_key("log_archive/123"))

    def test_ignores_a_non_numeric_id(self):
        self.assertIsNone(parse_key("log/not-a-number"))
        self.assertIsNone(parse_key("log/pytorch/executorch/not-a-number"))

    def test_ignores_an_unattributable_depth(self):
        # `log/<owner>/<id>` gives no repo, and anything deeper is not ours.
        self.assertIsNone(parse_key("log/pytorch/123"))
        self.assertIsNone(parse_key("log/a/b/c/123"))

    def test_ignores_a_directory_marker(self):
        self.assertIsNone(parse_key("log/"))


class TestClassifierPayload(unittest.TestCase):
    def test_is_a_v2_request_the_classifier_can_parse(self):
        payload = classifier_payload("pytorch/executorch", 999)
        # log_classifier builds on lambda_http with only the apigw_http feature,
        # so version 2.0 and requestContext.http are what make it deserialize.
        self.assertEqual(payload["version"], "2.0")
        self.assertIn("http", payload["requestContext"])
        self.assertEqual(
            payload["queryStringParameters"],
            {"job_id": "999", "repo": "pytorch/executorch"},
        )
        self.assertEqual(
            payload["rawQueryString"], "job_id=999&repo=pytorch/executorch"
        )

    def test_is_json_serializable(self):
        json.dumps(classifier_payload("pytorch/pytorch", 1))


class TestLambdaHandler(unittest.TestCase):
    def test_invokes_the_classifier_asynchronously(self):
        with patch("lambda_function.lambda_client") as client:
            lambda_handler(s3_event("log/123345"), None)

        kwargs = client.invoke.call_args.kwargs
        self.assertEqual(kwargs["FunctionName"], "log_classifier")
        # Event, not RequestResponse: nothing here reads the classification.
        self.assertEqual(kwargs["InvocationType"], "Event")
        self.assertEqual(
            json.loads(kwargs["Payload"])["queryStringParameters"],
            {"job_id": "123345", "repo": "pytorch/pytorch"},
        )

    def test_handles_every_record_in_a_batch(self):
        with patch("lambda_function.lambda_client") as client:
            lambda_handler(s3_event("log/1", "log/pytorch/rl/2"), None)

        self.assertEqual(client.invoke.call_count, 2)

    def test_skips_a_key_it_cannot_attribute(self):
        with patch("lambda_function.lambda_client") as client:
            lambda_handler(s3_event("log/not-a-number"), None)

        client.invoke.assert_not_called()

    def test_one_failure_does_not_strand_the_batch(self):
        with patch("lambda_function.lambda_client") as client:
            client.invoke.side_effect = [RuntimeError("throttled"), None]
            lambda_handler(s3_event("log/1", "log/2"), None)

        self.assertEqual(client.invoke.call_count, 2)

    def test_an_empty_event_is_a_noop(self):
        with patch("lambda_function.lambda_client") as client:
            lambda_handler({}, None)

        client.invoke.assert_not_called()


if __name__ == "__main__":
    unittest.main()
