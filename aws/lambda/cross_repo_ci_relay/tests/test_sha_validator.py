import unittest
from unittest.mock import MagicMock, patch

import github
from utils.sha_validator import _SHA_CACHE, validate_sha


class TestShaValidator(unittest.TestCase):
    def setUp(self):
        _SHA_CACHE.clear()

    def tearDown(self):
        _SHA_CACHE.clear()

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
        self.assertEqual(mock_gh.get_repo.call_count, 1)

    def test_different_sha_not_cached(self):
        mock_gh = MagicMock()
        mock_gh.get_repo.return_value.get_commit.return_value = MagicMock()

        validate_sha("pytorch/pytorch", "sha1", gh_client=mock_gh)
        validate_sha("pytorch/pytorch", "sha2", gh_client=mock_gh)

        self.assertEqual(mock_gh.get_repo.call_count, 2)

    @patch("utils.sha_validator.time")
    def test_expired_cache_entry_evicted(self, mock_time):
        mock_time.monotonic.return_value = 1000.0
        _SHA_CACHE["pytorch/pytorch:old_sha"] = 1000.0

        mock_time.monotonic.return_value = 1000.0 + 3601
        mock_gh = MagicMock()
        mock_gh.get_repo.return_value.get_commit.return_value = MagicMock()

        validate_sha("pytorch/pytorch", "new_sha", gh_client=mock_gh)

        self.assertNotIn("pytorch/pytorch:old_sha", _SHA_CACHE)

    def test_non_404_error_propagates(self):
        mock_gh = MagicMock()
        mock_gh.get_repo.return_value.get_commit.side_effect = github.GithubException(
            500, {"message": "Server Error"}, None
        )

        with self.assertRaises(github.GithubException):
            validate_sha("pytorch/pytorch", "abc123", gh_client=mock_gh)

    def test_invalid_sha_not_cached(self):
        mock_gh = MagicMock()
        mock_gh.get_repo.return_value.get_commit.side_effect = github.GithubException(
            404, {"message": "Not Found"}, None
        )

        validate_sha("pytorch/pytorch", "bad_sha", gh_client=mock_gh)

        self.assertNotIn("pytorch/pytorch:bad_sha", _SHA_CACHE)


if __name__ == "__main__":
    unittest.main()
