import time
import unittest
from unittest.mock import MagicMock, patch

import github
from utils.sha_validator import _CacheEntry, _REPO_CACHE, _SHA_CACHE, validate_sha


class TestShaValidator(unittest.TestCase):
    def setUp(self):
        _SHA_CACHE.clear()
        _REPO_CACHE.clear()

    def tearDown(self):
        _SHA_CACHE.clear()
        _REPO_CACHE.clear()

    def test_valid_sha_returns_true(self):
        mock_gh = MagicMock()
        mock_gh.get_repo.return_value.get_commit.return_value = MagicMock()

        result = validate_sha("pytorch/pytorch", "abc123", gh_client=mock_gh)

        self.assertTrue(result)
        mock_gh.get_repo.assert_called_once_with("pytorch/pytorch")

    def test_invalid_sha_returns_false(self):
        mock_gh = MagicMock()
        mock_gh.get_repo.return_value.get_commit.side_effect = github.GithubException(
            404, {"message": "Not Found"}, None
        )

        result = validate_sha("pytorch/pytorch", "bad_sha", gh_client=mock_gh)

        self.assertFalse(result)

    def test_cache_hit_skips_api_call(self):
        mock_gh = MagicMock()
        mock_gh.get_repo.return_value.get_commit.return_value = MagicMock()

        validate_sha("pytorch/pytorch", "abc123", gh_client=mock_gh)
        self.assertEqual(mock_gh.get_repo.call_count, 1)

        validate_sha("pytorch/pytorch", "abc123", gh_client=mock_gh)
        # repo handle is cached, so get_repo is only called once
        self.assertEqual(mock_gh.get_repo.call_count, 1)

    def test_different_sha_not_cached(self):
        mock_gh = MagicMock()
        mock_repo = MagicMock()
        mock_gh.get_repo.return_value = mock_repo

        validate_sha("pytorch/pytorch", "sha1", gh_client=mock_gh)
        validate_sha("pytorch/pytorch", "sha2", gh_client=mock_gh)

        # repo handle cached, but get_commit called twice (different SHAs)
        self.assertEqual(mock_repo.get_commit.call_count, 2)

    @patch("utils.sha_validator.time")
    def test_expired_cache_entry_evicted(self, mock_time):
        mock_time.monotonic.return_value = 1000.0
        _SHA_CACHE["pytorch/pytorch:old_sha"] = _CacheEntry(
            exists=True, timestamp=1000.0
        )

        mock_time.monotonic.return_value = 1000.0 + 3601
        mock_gh = MagicMock()
        mock_gh.get_repo.return_value.get_commit.return_value = MagicMock()

        validate_sha("pytorch/pytorch", "new_sha", gh_client=mock_gh)

        self.assertNotIn("pytorch/pytorch:old_sha", _SHA_CACHE)

    def test_transient_error_fails_open(self):
        mock_gh = MagicMock()
        mock_gh.get_repo.return_value.get_commit.side_effect = github.GithubException(
            500, {"message": "Server Error"}, None
        )

        result = validate_sha("pytorch/pytorch", "abc123", gh_client=mock_gh)

        self.assertTrue(result)

    def test_rate_limit_403_fails_open(self):
        mock_gh = MagicMock()
        mock_gh.get_repo.return_value.get_commit.side_effect = github.GithubException(
            403, {"message": "rate limit exceeded"}, None
        )

        result = validate_sha("pytorch/pytorch", "abc123", gh_client=mock_gh)

        self.assertTrue(result)

    def test_negative_cache_hit_returns_false(self):
        mock_gh = MagicMock()
        mock_gh.get_repo.return_value.get_commit.side_effect = github.GithubException(
            404, {"message": "Not Found"}, None
        )

        validate_sha("pytorch/pytorch", "bad_sha", gh_client=mock_gh)
        self.assertIn("pytorch/pytorch:bad_sha", _SHA_CACHE)
        self.assertFalse(_SHA_CACHE["pytorch/pytorch:bad_sha"].exists)

        # Second call hits the negative cache — no additional API call
        mock_gh.get_repo.return_value.get_commit.reset_mock()
        result = validate_sha("pytorch/pytorch", "bad_sha", gh_client=mock_gh)
        self.assertFalse(result)
        mock_gh.get_repo.return_value.get_commit.assert_not_called()

    @patch("utils.sha_validator.time")
    def test_negative_cache_expires_sooner(self, mock_time):
        mock_time.monotonic.return_value = 1000.0
        _SHA_CACHE["pytorch/pytorch:bad_sha"] = _CacheEntry(
            exists=False, timestamp=1000.0
        )

        # After 301 seconds (> 300s negative TTL), entry should be evicted
        mock_time.monotonic.return_value = 1000.0 + 301
        mock_gh = MagicMock()
        mock_gh.get_repo.return_value.get_commit.side_effect = github.GithubException(
            404, {"message": "Not Found"}, None
        )

        result = validate_sha("pytorch/pytorch", "bad_sha", gh_client=mock_gh)
        self.assertFalse(result)
        # API was called again because cache was evicted
        mock_gh.get_repo.return_value.get_commit.assert_called_once()

    def test_cached_valid_sha_short_circuits_even_if_api_would_404(self):
        """A previously cached valid SHA returns True without hitting the API,
        even if the API would now return 404."""
        _SHA_CACHE["pytorch/pytorch:abc123"] = _CacheEntry(
            exists=True, timestamp=time.monotonic()
        )

        mock_gh = MagicMock()
        mock_gh.get_repo.return_value.get_commit.side_effect = github.GithubException(
            404, {"message": "Not Found"}, None
        )

        result = validate_sha("pytorch/pytorch", "abc123", gh_client=mock_gh)

        self.assertTrue(result)
        mock_gh.get_repo.return_value.get_commit.assert_not_called()

    def test_repo_handle_cached(self):
        mock_gh = MagicMock()
        mock_repo = MagicMock()
        mock_gh.get_repo.return_value = mock_repo

        validate_sha("pytorch/pytorch", "sha1", gh_client=mock_gh)
        validate_sha("pytorch/pytorch", "sha2", gh_client=mock_gh)

        # get_repo only called once due to repo handle caching
        mock_gh.get_repo.assert_called_once_with("pytorch/pytorch")


if __name__ == "__main__":
    unittest.main()
