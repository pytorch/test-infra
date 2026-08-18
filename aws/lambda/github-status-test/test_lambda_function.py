import unittest
from unittest.mock import MagicMock, patch

import lambda_function
from lambda_function import download_log, installation_token


def make_response(status_code, content=b"log data", headers=None):
    response = MagicMock()
    response.status_code = status_code
    response.ok = 200 <= status_code < 300
    response.content = content
    response.headers = headers or {}
    return response


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
        # A misconfigured key must not escape as an exception: the webhook still
        # has to archive its payload after the log download is skipped.
        self.assertIsNone(installation_token("pytorch/pytorch"))


@patch.object(lambda_function, "GITHUB_TOKENS", "pat1,pat2")
@patch.object(lambda_function, "s3")
@patch.object(lambda_function, "urlopen")
class TestDownloadLog(unittest.TestCase):
    def setUp(self):
        lambda_function._token_cache.clear()

    def test_uses_app_token_when_available(self, urlopen, s3):
        with patch.object(
            lambda_function, "installation_token", return_value="app-token"
        ), patch.object(
            lambda_function, "fetch_log", return_value=make_response(200)
        ) as fetch_log:
            download_log("pytorch/pytorch", "failure", 123)

        fetch_log.assert_called_once_with("pytorch/pytorch", 123, "app-token")
        s3.Object.assert_called_once_with("ossci-raw-job-status", "log/123")
        urlopen.assert_called_once()

    def test_falls_back_to_pat_when_rate_limited(self, urlopen, s3):
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

    def test_rate_limited_app_is_skipped_until_reset(self, urlopen, s3):
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

    def test_error_response_is_not_archived(self, urlopen, s3):
        with patch.object(
            lambda_function, "installation_token", return_value=None
        ), patch.object(
            lambda_function,
            "fetch_log",
            return_value=make_response(404, content=b'{"message": "Not Found"}'),
        ):
            download_log("pytorch/pytorch", "skipped", 123)

        s3.Object.assert_not_called()
        urlopen.assert_not_called()

    def test_non_pytorch_repo_is_prefixed(self, urlopen, s3):
        with patch.object(
            lambda_function, "installation_token", return_value=None
        ), patch.object(lambda_function, "fetch_log", return_value=make_response(200)):
            download_log("pytorch/executorch", "success", 999)

        s3.Object.assert_called_once_with(
            "ossci-raw-job-status", "log/pytorch/executorch/999"
        )

    def test_no_credentials_at_all_is_a_noop(self, urlopen, s3):
        with patch.object(
            lambda_function, "installation_token", return_value=None
        ), patch.object(lambda_function, "GITHUB_TOKENS", None), patch.object(
            lambda_function, "fetch_log"
        ) as fetch_log:
            download_log("pytorch/pytorch", "failure", 123)

        fetch_log.assert_not_called()
        s3.Object.assert_not_called()


if __name__ == "__main__":
    unittest.main()
