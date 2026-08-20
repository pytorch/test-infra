import json
import unittest
from unittest.mock import MagicMock, patch

import lambda_function
from lambda_function import (
    classifier_payload,
    classify_log,
    download_log,
    installation_token,
    parse_event,
)


def make_response(status_code, content=b"log data", headers=None):
    response = MagicMock()
    response.status_code = status_code
    response.ok = 200 <= status_code < 300
    response.content = content
    response.headers = headers or {}
    return response


class TestParseEvent(unittest.TestCase):
    def test_parses_a_well_formed_payload(self):
        self.assertEqual(
            parse_event(
                {"repo": "pytorch/pytorch", "job_id": 123, "conclusion": "failure"}
            ),
            ("pytorch/pytorch", "failure", 123),
        )

    def test_job_id_may_arrive_as_a_string(self):
        # JSON from a JS caller can widen a number to a string; both are fine.
        self.assertEqual(
            parse_event({"repo": "pytorch/pytorch", "job_id": "123"})[2], 123
        )

    def test_conclusion_is_optional(self):
        self.assertIsNone(parse_event({"repo": "pytorch/pytorch", "job_id": 1})[1])

    def test_rejects_a_repo_without_an_owner(self):
        with self.assertRaises(ValueError):
            parse_event({"repo": "pytorch", "job_id": 1})

    def test_rejects_a_missing_repo(self):
        with self.assertRaises(ValueError):
            parse_event({"job_id": 1})

    def test_rejects_a_non_numeric_job_id(self):
        with self.assertRaises(ValueError):
            parse_event({"repo": "pytorch/pytorch", "job_id": "not a number"})

    def test_rejects_a_non_object_payload(self):
        with self.assertRaises(ValueError):
            parse_event(["pytorch/pytorch", 123])


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
        self.assertEqual(payload["rawQueryString"], "job_id=999&repo=pytorch/executorch")

    def test_is_json_serializable(self):
        json.dumps(classifier_payload("pytorch/pytorch", 1))


class TestClassifyLog(unittest.TestCase):
    def test_invokes_the_classifier_asynchronously(self):
        with patch.object(lambda_function, "lambda_client") as client:
            self.assertTrue(classify_log("pytorch/pytorch", 123))

        kwargs = client.invoke.call_args.kwargs
        self.assertEqual(kwargs["FunctionName"], "log_classifier")
        # Event, not RequestResponse: waiting on classification is exactly the
        # mistake that gave github-status-test its multi-hundred-second tails.
        self.assertEqual(kwargs["InvocationType"], "Event")
        self.assertEqual(
            json.loads(kwargs["Payload"])["queryStringParameters"],
            {"job_id": "123", "repo": "pytorch/pytorch"},
        )

    def test_a_failed_invoke_is_reported_not_raised(self):
        # Raising would make Lambda retry the whole function, re-downloading a
        # multi-megabyte log to retry a handoff that takes milliseconds.
        with patch.object(lambda_function, "lambda_client") as client:
            client.invoke.side_effect = RuntimeError("throttled")
            self.assertFalse(classify_log("pytorch/pytorch", 123))


class TestInstallationToken(unittest.TestCase):
    def setUp(self):
        lambda_function._token_cache.clear()

    @patch.object(lambda_function, "GITHUB_APP_ID", None)
    @patch.object(lambda_function, "GITHUB_APP_PRIVATE_KEY", None)
    def test_returns_none_without_app_credentials(self):
        with patch.object(lambda_function, "fetch_installation_token") as fetch:
            self.assertIsNone(installation_token("pytorch/pytorch"))
            fetch.assert_not_called()

    @patch.object(lambda_function, "GITHUB_APP_ID", "4550824")
    @patch.object(lambda_function, "GITHUB_APP_PRIVATE_KEY", "key")
    def test_token_is_cached_per_repo(self):
        with patch.object(
            lambda_function,
            "fetch_installation_token",
            return_value=("tok", 2**31),
        ) as fetch:
            self.assertEqual(installation_token("pytorch/pytorch"), "tok")
            self.assertEqual(installation_token("pytorch/pytorch"), "tok")
            # Same repo twice is one mint...
            fetch.assert_called_once()
            # ...but a sibling repo resolves separately, because a "Selected
            # repositories" install can cover one and not the other.
            self.assertEqual(installation_token("pytorch/executorch"), "tok")
            self.assertEqual(fetch.call_count, 2)

    @patch.object(lambda_function, "GITHUB_APP_ID", "4550824")
    @patch.object(lambda_function, "GITHUB_APP_PRIVATE_KEY", "key")
    def test_uninstalled_sibling_does_not_mask_an_installed_repo(self):
        # Under a "Selected repositories" install, querying the uninstalled
        # sibling first must not park the whole owner on the PAT path.
        def per_repo(full_name):
            if full_name == "pytorch/not-installed":
                return None, 2**31
            return "tok", 2**31

        with patch.object(
            lambda_function, "fetch_installation_token", side_effect=per_repo
        ):
            self.assertIsNone(installation_token("pytorch/not-installed"))
            self.assertEqual(installation_token("pytorch/pytorch"), "tok")

    @patch.object(lambda_function, "GITHUB_APP_ID", "4550824")
    @patch.object(lambda_function, "GITHUB_APP_PRIVATE_KEY", "key")
    def test_expired_cache_entry_is_refreshed(self):
        lambda_function._token_cache["pytorch/pytorch"] = ("stale", 0)
        with patch.object(
            lambda_function,
            "fetch_installation_token",
            return_value=("fresh", 2**31),
        ):
            self.assertEqual(installation_token("pytorch/pytorch"), "fresh")

    @patch.object(lambda_function, "GITHUB_APP_ID", "4550824")
    @patch.object(lambda_function, "GITHUB_APP_PRIVATE_KEY", "key")
    def test_uninstalled_owner_is_cached_as_none(self):
        with patch.object(
            lambda_function,
            "fetch_installation_token",
            return_value=(None, 2**31),
        ) as fetch:
            self.assertIsNone(installation_token("vllm-project/vllm"))
            self.assertIsNone(installation_token("vllm-project/vllm"))
            fetch.assert_called_once()

    @patch.object(lambda_function, "GITHUB_APP_ID", "4550824")
    @patch.object(lambda_function, "GITHUB_APP_PRIVATE_KEY", "key")
    def test_mint_failure_is_not_cached(self):
        with patch.object(
            lambda_function,
            "fetch_installation_token",
            side_effect=lambda_function.requests.RequestException("boom"),
        ):
            self.assertIsNone(installation_token("pytorch/pytorch"))
        self.assertNotIn("pytorch/pytorch", lambda_function._token_cache)

    @patch.object(lambda_function, "GITHUB_APP_ID", "4550824")
    @patch.object(lambda_function, "GITHUB_APP_PRIVATE_KEY", "bm90LWEta2V5")
    def test_unparseable_private_key_degrades_to_none(self):
        # A misconfigured key must not escape as an exception, or Lambda retries
        # it twice and DLQs a job whose log the PAT pool could have fetched.
        self.assertIsNone(installation_token("pytorch/pytorch"))


@patch.object(lambda_function, "GITHUB_TOKENS", "pat1,pat2")
@patch.object(lambda_function, "s3")
class TestDownloadLog(unittest.TestCase):
    def setUp(self):
        lambda_function._token_cache.clear()

    def test_uses_app_token_when_available(self, s3):
        with patch.object(
            lambda_function, "installation_token", return_value="app-token"
        ), patch.object(
            lambda_function, "fetch_log", return_value=make_response(200)
        ) as fetch_log:
            self.assertTrue(download_log("pytorch/pytorch", "failure", 123))

        fetch_log.assert_called_once_with("pytorch/pytorch", 123, "app-token")
        s3.Object.assert_called_once_with("ossci-raw-job-status", "log/123")

    def test_falls_back_to_pat_when_rate_limited(self, s3):
        responses = [
            make_response(403, headers={"x-ratelimit-remaining": "0"}),
            make_response(200),
        ]
        with patch.object(
            lambda_function, "installation_token", return_value="app-token"
        ), patch.object(
            lambda_function, "fetch_log", side_effect=responses
        ) as fetch_log:
            download_log("pytorch/pytorch", "failure", 123)

        self.assertEqual(fetch_log.call_count, 2)
        self.assertIn(fetch_log.call_args_list[1][0][2], ("pat1", "pat2"))
        # The log still gets archived via the fallback credential
        s3.Object.assert_called_once_with("ossci-raw-job-status", "log/123")

    def test_rate_limited_app_is_skipped_until_reset(self, s3):
        reset_at = 2**31
        responses = [
            make_response(429, headers={"x-ratelimit-reset": str(reset_at)}),
            make_response(200),
            make_response(200),
        ]
        with patch.object(
            lambda_function, "fetch_installation_token", return_value=("app", 2**31)
        ), patch.object(lambda_function, "GITHUB_APP_ID", "4550824"), patch.object(
            lambda_function, "GITHUB_APP_PRIVATE_KEY", "key"
        ), patch.object(
            lambda_function, "fetch_log", side_effect=responses
        ) as fetch_log:
            download_log("pytorch/pytorch", "failure", 123)
            download_log("pytorch/pytorch", "failure", 456)

        # 2 calls for the first job (app then PAT), 1 for the second (PAT only)
        self.assertEqual(fetch_log.call_count, 3)
        self.assertEqual(
            lambda_function._token_cache["pytorch/pytorch"], (None, float(reset_at))
        )

    def test_error_response_is_not_archived(self, s3):
        with patch.object(
            lambda_function, "installation_token", return_value=None
        ), patch.object(
            lambda_function,
            "fetch_log",
            return_value=make_response(404, content=b'{"message": "Not Found"}'),
        ):
            self.assertFalse(download_log("pytorch/pytorch", "skipped", 123))

        s3.Object.assert_not_called()

    def test_non_pytorch_repo_is_prefixed(self, s3):
        with patch.object(
            lambda_function, "installation_token", return_value=None
        ), patch.object(lambda_function, "fetch_log", return_value=make_response(200)):
            download_log("pytorch/executorch", "success", 999)

        s3.Object.assert_called_once_with(
            "ossci-raw-job-status", "log/pytorch/executorch/999"
        )

    def test_no_credentials_at_all_is_a_noop(self, s3):
        with patch.object(
            lambda_function, "installation_token", return_value=None
        ), patch.object(lambda_function, "GITHUB_TOKENS", None), patch.object(
            lambda_function, "fetch_log"
        ) as fetch_log:
            self.assertFalse(download_log("pytorch/pytorch", "failure", 123))

        fetch_log.assert_not_called()
        s3.Object.assert_not_called()

    def test_a_null_conclusion_is_stored_as_empty(self, s3):
        # workflow_job.conclusion is nullable; S3 metadata values must be strings.
        with patch.object(
            lambda_function, "installation_token", return_value=None
        ), patch.object(lambda_function, "fetch_log", return_value=make_response(200)):
            download_log("pytorch/pytorch", None, 123)

        self.assertEqual(
            s3.Object.return_value.put.call_args.kwargs["Metadata"], {"conclusion": ""}
        )


@patch.object(lambda_function, "s3")
class TestLambdaHandler(unittest.TestCase):
    def test_returns_a_summary(self, s3):
        with patch.object(
            lambda_function, "download_log", return_value=True
        ), patch.object(lambda_function, "classify_log", return_value=True):
            self.assertEqual(
                lambda_function.lambda_handler(
                    {"repo": "pytorch/pytorch", "job_id": 5, "conclusion": "success"},
                    None,
                ),
                {
                    "repo": "pytorch/pytorch",
                    "job_id": 5,
                    "stored": True,
                    "classified": True,
                },
            )

    def test_does_not_classify_a_log_that_was_never_stored(self, s3):
        # A 404 from GitHub means there is nothing in S3 for the classifier to
        # read, so asking it to try would only produce a confusing failure.
        with patch.object(
            lambda_function, "download_log", return_value=False
        ), patch.object(lambda_function, "classify_log") as classify:
            result = lambda_function.lambda_handler(
                {"repo": "pytorch/pytorch", "job_id": 5}, None
            )

        classify.assert_not_called()
        self.assertFalse(result["classified"])

    def test_a_github_blip_propagates_so_lambda_retries(self, s3):
        with patch.object(
            lambda_function,
            "download_log",
            side_effect=lambda_function.requests.RequestException("boom"),
        ):
            with self.assertRaises(lambda_function.requests.RequestException):
                lambda_function.lambda_handler(
                    {"repo": "pytorch/pytorch", "job_id": 5}, None
                )


if __name__ == "__main__":
    unittest.main()
