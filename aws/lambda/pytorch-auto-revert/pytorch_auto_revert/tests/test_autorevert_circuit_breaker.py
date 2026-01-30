import logging
import unittest
from unittest.mock import MagicMock, patch

from pytorch_auto_revert.autorevert_circuit_breaker import check_autorevert_disabled


def create_mock_issue(number: int, user_login: str, is_pr: bool = False):
    """Helper to create a mock issue or PR."""
    mock_item = MagicMock()
    mock_item.number = number
    mock_item.user.login = user_login
    # If it's a PR, pull_request attribute is not None
    mock_item.pull_request = MagicMock() if is_pr else None
    return mock_item


class TestAutorevertCircuitBreaker(unittest.TestCase):
    """Test suite for autorevert circuit breaker functionality."""

    @patch("pytorch_auto_revert.autorevert_circuit_breaker.GHClientFactory")
    def test_circuit_breaker_disabled_when_no_issues(self, mock_factory):
        """Circuit breaker should be inactive when no issues with label exist."""
        mock_repo = MagicMock()
        mock_repo.get_issues.return_value = []
        mock_factory.return_value.client.get_repo.return_value = mock_repo

        result = check_autorevert_disabled("pytorch/pytorch")

        self.assertFalse(result)
        mock_repo.get_issues.assert_called_once_with(
            state="open", labels=["ci: disable-autorevert"]
        )

    @patch("pytorch_auto_revert.autorevert_circuit_breaker.GHClientFactory")
    def test_circuit_breaker_enabled_when_issue_exists(self, mock_factory):
        """Circuit breaker should be active when an open issue with label exists."""
        mock_issue = create_mock_issue(
            number=12345, user_login="test-user", is_pr=False
        )
        mock_repo = MagicMock()
        mock_repo.get_issues.return_value = [mock_issue]
        mock_factory.return_value.client.get_repo.return_value = mock_repo

        result = check_autorevert_disabled("pytorch/pytorch")

        self.assertTrue(result)

    @patch("pytorch_auto_revert.autorevert_circuit_breaker.GHClientFactory")
    def test_circuit_breaker_ignores_pull_requests(self, mock_factory):
        """Circuit breaker should ignore PRs with the label, only consider issues."""
        mock_pr = create_mock_issue(number=67890, user_login="test-user", is_pr=True)
        mock_repo = MagicMock()
        mock_repo.get_issues.return_value = [mock_pr]
        mock_factory.return_value.client.get_repo.return_value = mock_repo

        with self.assertLogs(level=logging.DEBUG) as log_ctx:
            result = check_autorevert_disabled("pytorch/pytorch")

        self.assertFalse(result)
        log_output = "\n".join(log_ctx.output)
        self.assertIn("Skipping PR #67890", log_output)
        self.assertIn("Circuit breaker only responds to issues, not PRs", log_output)

    @patch("pytorch_auto_revert.autorevert_circuit_breaker.GHClientFactory")
    def test_circuit_breaker_with_mixed_issues_and_prs(self, mock_factory):
        """Circuit breaker should activate on issue but skip PR when both exist."""
        mock_pr = create_mock_issue(number=100, user_login="pr-author", is_pr=True)
        mock_issue = create_mock_issue(
            number=200, user_login="issue-author", is_pr=False
        )
        mock_repo = MagicMock()
        mock_repo.get_issues.return_value = [mock_pr, mock_issue]
        mock_factory.return_value.client.get_repo.return_value = mock_repo

        with self.assertLogs(level=logging.DEBUG) as log_ctx:
            result = check_autorevert_disabled("pytorch/pytorch")

        self.assertTrue(result)
        log_output = "\n".join(log_ctx.output)
        self.assertIn("Skipping PR #100", log_output)
        self.assertIn("Found open issue #200", log_output)

    @patch("pytorch_auto_revert.autorevert_circuit_breaker.GHClientFactory")
    def test_circuit_breaker_handles_exceptions(self, mock_factory):
        """Circuit breaker should return False and log error on exceptions."""
        mock_repo = MagicMock()
        mock_repo.get_issues.side_effect = Exception("API Error")
        mock_factory.return_value.client.get_repo.return_value = mock_repo

        with self.assertLogs(level=logging.ERROR) as log_ctx:
            result = check_autorevert_disabled("pytorch/pytorch")

        self.assertFalse(result)
        log_output = "\n".join(log_ctx.output)
        self.assertIn("Error checking autorevert circuit breaker", log_output)

    @patch("pytorch_auto_revert.autorevert_circuit_breaker.GHClientFactory")
    def test_circuit_breaker_uses_custom_repo(self, mock_factory):
        """Circuit breaker should work with custom repository names."""
        mock_repo = MagicMock()
        mock_repo.get_issues.return_value = []
        mock_factory.return_value.client.get_repo.return_value = mock_repo

        check_autorevert_disabled("custom/repo")

        mock_repo.get_issues.assert_called_once()

    @patch("pytorch_auto_revert.autorevert_circuit_breaker.GHClientFactory")
    def test_circuit_breaker_allows_approved_user(self, mock_factory):
        """Circuit breaker should activate when issue is created by approved user."""
        mock_issue = create_mock_issue(
            number=12345, user_login="approved-user", is_pr=False
        )
        mock_repo = MagicMock()
        mock_repo.get_issues.return_value = [mock_issue]
        mock_factory.return_value.client.get_repo.return_value = mock_repo

        approved_users = {"approved-user", "another-approved-user"}
        result = check_autorevert_disabled("pytorch/pytorch", approved_users)

        self.assertTrue(result)

    @patch("pytorch_auto_revert.autorevert_circuit_breaker.GHClientFactory")
    def test_circuit_breaker_blocks_unapproved_user(self, mock_factory):
        """Circuit breaker should not activate when issue is created by unapproved user."""
        mock_issue = create_mock_issue(
            number=12345, user_login="unauthorized-user", is_pr=False
        )
        mock_repo = MagicMock()
        mock_repo.get_issues.return_value = [mock_issue]
        mock_factory.return_value.client.get_repo.return_value = mock_repo

        approved_users = {"approved-user", "another-approved-user"}

        with self.assertLogs(level=logging.WARNING) as log_ctx:
            result = check_autorevert_disabled("pytorch/pytorch", approved_users)

        self.assertFalse(result)
        log_output = "\n".join(log_ctx.output)
        self.assertIn("Ignoring issue #12345", log_output)
        self.assertIn(
            "User 'unauthorized-user' is not in the approved users list", log_output
        )

    @patch("pytorch_auto_revert.autorevert_circuit_breaker.GHClientFactory")
    def test_circuit_breaker_no_approval_check_when_empty_set(self, mock_factory):
        """Circuit breaker should not check approval when approved_users is empty."""
        mock_issue = create_mock_issue(number=12345, user_login="any-user", is_pr=False)
        mock_repo = MagicMock()
        mock_repo.get_issues.return_value = [mock_issue]
        mock_factory.return_value.client.get_repo.return_value = mock_repo

        # Empty set should skip approval check
        result = check_autorevert_disabled("pytorch/pytorch", set())

        self.assertTrue(result)

    @patch("pytorch_auto_revert.autorevert_circuit_breaker.GHClientFactory")
    def test_circuit_breaker_no_approval_check_when_none(self, mock_factory):
        """Circuit breaker should not check approval when approved_users is None."""
        mock_issue = create_mock_issue(number=12345, user_login="any-user", is_pr=False)
        mock_repo = MagicMock()
        mock_repo.get_issues.return_value = [mock_issue]
        mock_factory.return_value.client.get_repo.return_value = mock_repo

        # None should skip approval check
        result = check_autorevert_disabled("pytorch/pytorch", None)

        self.assertTrue(result)

    @patch("pytorch_auto_revert.autorevert_circuit_breaker.GHClientFactory")
    def test_circuit_breaker_with_mixed_approved_and_unapproved(self, mock_factory):
        """Circuit breaker should activate if any issue is from approved user."""
        mock_unapproved = create_mock_issue(
            number=100, user_login="unauthorized", is_pr=False
        )
        mock_approved = create_mock_issue(
            number=200, user_login="approved-user", is_pr=False
        )
        mock_repo = MagicMock()
        mock_repo.get_issues.return_value = [mock_unapproved, mock_approved]
        mock_factory.return_value.client.get_repo.return_value = mock_repo

        approved_users = {"approved-user"}

        with self.assertLogs(level=logging.INFO) as log_ctx:
            result = check_autorevert_disabled("pytorch/pytorch", approved_users)

        self.assertTrue(result)
        log_output = "\n".join(log_ctx.output)
        self.assertIn("Ignoring issue #100", log_output)
        self.assertIn("Found open issue #200", log_output)


if __name__ == "__main__":
    unittest.main()
