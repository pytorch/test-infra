"""Verify the dispatch path does not retry POST 5xx in PyGithub's urllib3 layer.

GitHub's POST /repos/{owner}/{repo}/actions/workflows/{id}/dispatches is not idempotent:
the server can return 5xx after it has already accepted the dispatch and created a
workflow run. PyGithub's default GithubRetry retries 5xx for POST, which silently
spawns duplicate runs during a GitHub outage. The autorevert lambda routes dispatches
through ``GHClientFactory().dispatch_client`` (constructed with ``retry=0``) and asks
``proper_workflow_create_dispatch`` to use that client's requester explicitly.
"""

import sys
import unittest
from unittest.mock import MagicMock, patch


# Ensure package import when running from repo root
sys.path.insert(0, "aws/lambda/pytorch-auto-revert")

from pytorch_auto_revert.github_client_helper import GHClientFactory  # noqa: E402
from pytorch_auto_revert.utils import proper_workflow_create_dispatch  # noqa: E402


def _reset_factory() -> "GHClientFactory":
    GHClientFactory.setup_client(token="test-token")
    if hasattr(GHClientFactory, "_instance"):
        del GHClientFactory._instance
    factory = GHClientFactory()
    factory._data.pop("client", None)
    factory._data.pop("dispatch_client", None)
    return factory


class TestDispatchClientNoRetry(unittest.TestCase):
    def test_dispatch_client_constructed_with_retry_zero(self):
        """``dispatch_client`` passes ``retry=0`` to ``github.Github(...)``."""
        factory = _reset_factory()
        with patch(
            "pytorch_auto_revert.github_client_helper.github.Github"
        ) as mock_github:
            mock_github.return_value = MagicMock(name="dispatch_client")
            _ = factory.dispatch_client
            self.assertEqual(mock_github.call_count, 1)
            kwargs = mock_github.call_args.kwargs
            self.assertEqual(
                kwargs.get("retry"),
                0,
                f"dispatch_client must be constructed with retry=0, got kwargs={kwargs!r}",
            )

    def test_default_client_does_not_set_retry_zero(self):
        """The default ``client`` keeps PyGithub's automatic retry behavior."""
        factory = _reset_factory()
        with patch(
            "pytorch_auto_revert.github_client_helper.github.Github"
        ) as mock_github:
            mock_github.return_value = MagicMock(name="default_client")
            _ = factory.client
            self.assertEqual(mock_github.call_count, 1)
            kwargs = mock_github.call_args.kwargs
            # The default client must not opt out of PyGithub retries — that path
            # also covers idempotent GETs and rate-limit-aware 403 retries.
            self.assertNotEqual(kwargs.get("retry", "unset"), 0)

    def test_dispatch_client_cached_and_distinct(self):
        factory = _reset_factory()
        with patch(
            "pytorch_auto_revert.github_client_helper.github.Github"
        ) as mock_github:
            mock_github.side_effect = [
                MagicMock(name="default"),
                MagicMock(name="dispatch"),
            ]
            c1 = factory.client
            c2 = factory.client
            d1 = factory.dispatch_client
            d2 = factory.dispatch_client
            self.assertIs(c1, c2)
            self.assertIs(d1, d2)
            self.assertIsNot(c1, d1)
            self.assertEqual(mock_github.call_count, 2)

    def test_proper_workflow_create_dispatch_uses_passed_requester(self):
        """When ``requester`` is provided, the workflow's own requester is bypassed."""
        workflow = MagicMock()
        workflow.url = "https://api.github.com/repos/o/r/actions/workflows/1"
        workflow._requester = MagicMock()
        workflow._requester.requestJson.return_value = (
            204,
            {},
            "",
        )

        explicit_requester = MagicMock()
        explicit_requester.requestJson.return_value = (204, {}, "")

        proper_workflow_create_dispatch(
            workflow,
            ref="trunk/abc",
            inputs={"k": "v"},
            requester=explicit_requester,
        )

        # The explicit requester is used; the workflow's own requester is not.
        explicit_requester.requestJson.assert_called_once()
        workflow._requester.requestJson.assert_not_called()

    def test_proper_workflow_create_dispatch_default_requester(self):
        """Without ``requester``, the workflow's own requester is used (back-compat)."""
        workflow = MagicMock()
        workflow.url = "https://api.github.com/repos/o/r/actions/workflows/1"
        workflow._requester = MagicMock()
        workflow._requester.requestJson.return_value = (204, {}, "")

        proper_workflow_create_dispatch(
            workflow,
            ref="trunk/abc",
            inputs={"k": "v"},
        )

        workflow._requester.requestJson.assert_called_once()


if __name__ == "__main__":
    unittest.main()
