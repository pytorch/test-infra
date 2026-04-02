import unittest
from unittest.mock import call, MagicMock, patch

from event_handler import handle


def _cfg():
    cfg = MagicMock()
    cfg.github_app_id = "12345"
    cfg.github_app_private_key = "fake-key"
    cfg.max_dispatch_workers = 4
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
    def test_ignored_action(self):
        self.assertEqual(
            handle(_cfg(), _payload(action="closed"), "pull_request", "delivery-1"),
            {"ignored": True},
        )

    @patch("event_handler.gh_helper.create_repository_dispatch")
    @patch("event_handler.gh_helper.get_repo_access_token", return_value="tok")
    @patch("event_handler.load_allowlist")
    def test_dispatch_success(self, mock_load, _tok, mock_dispatch):
        mock_load.return_value = MagicMock(
            get_repos_at_or_above_level=MagicMock(return_value=(["org/a"], []))
        )
        result = handle(_cfg(), _payload(action="opened"), "pull_request", "delivery-1")
        self.assertTrue(result["ok"])
        mock_dispatch.assert_called_once()

    @patch("event_handler.gh_helper.create_repository_dispatch")
    @patch(
        "event_handler.gh_helper.get_repo_access_token",
        side_effect=["tok-a", "tok-b"],
    )
    @patch("event_handler.load_allowlist")
    def test_dispatch_mints_token_per_downstream_repo(
        self, mock_load, mock_get_repo_access_token, mock_dispatch
    ):
        mock_load.return_value = MagicMock(
            get_repos_at_or_above_level=MagicMock(
                return_value=(["huawei/repo", "pytorch/repo"], [])
            )
        )

        result = handle(_cfg(), _payload(action="opened"), "pull_request", "delivery-2")

        self.assertTrue(result["ok"])
        self.assertEqual(mock_get_repo_access_token.call_count, 2)
        mock_get_repo_access_token.assert_has_calls(
            [
                call("12345", "fake-key", "huawei/repo"),
                call("12345", "fake-key", "pytorch/repo"),
            ],
            any_order=True,
        )
        self.assertEqual(mock_dispatch.call_count, 2)


if __name__ == "__main__":
    unittest.main()
