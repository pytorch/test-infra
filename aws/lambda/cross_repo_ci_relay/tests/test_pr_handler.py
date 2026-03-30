import unittest
from unittest.mock import MagicMock, patch

from github import GithubException

from pr_handler import extract_pr_fields, handle
from utils import HTTPException


def _cfg():
    cfg = MagicMock()
    cfg.github_app_id = "12345"
    cfg.github_app_private_key = "fake-key"
    return cfg


def _payload(action="synchronize"):
    return {
        "action": action,
        "repository": {"full_name": "pytorch/pytorch"},
        "pull_request": {
            "head": {"sha": "abc123", "ref": "feat"},
            "base": {"ref": "main"},
            "number": 42,
        },
        "installation": {"id": 99},
    }


class TestPRHandler(unittest.TestCase):
    def test_extract_missing_field_raises_400(self):
        p = _payload()
        del p["installation"]
        with self.assertRaises(HTTPException) as ctx:
            extract_pr_fields(p)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_ignored_action(self):
        self.assertEqual(handle(_cfg(), _payload(action="closed")), {"ignored": True})

    @patch("pr_handler.gh_helper.create_repository_dispatch")
    @patch("pr_handler.gh_helper.get_access_token", return_value="tok")
    @patch("pr_handler.load_allowlist")
    def test_dispatch_success(self, mock_load, _tok, mock_dispatch):
        mock_load.return_value = MagicMock(
            get_from_level=MagicMock(return_value=(["org/a"], []))
        )
        result = handle(_cfg(), _payload(action="opened"))
        self.assertTrue(result["ok"])
        mock_dispatch.assert_called_once()


if __name__ == "__main__":
    unittest.main()
