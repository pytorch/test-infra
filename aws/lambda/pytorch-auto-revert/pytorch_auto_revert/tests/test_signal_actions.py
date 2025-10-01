import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, Mock, patch

from pytorch_auto_revert.signal_actions import (
    ActionLogger,
    CommitPRSourceAction,
    SignalActionProcessor,
    SignalMetadata,
)
from pytorch_auto_revert.signal_extraction_types import RunContext
from pytorch_auto_revert.utils import RestartAction, RevertAction


# flake8: noqa


class FakeLogger:
    def __init__(self):
        self._recent = []
        self.insert_calls = []

    def prior_revert_exists(
        self,
        *,
        repo: str,
        commit_sha: str,
    ) -> bool:
        return False

    def restart_stats(
        self,
        *,
        repo: str,
        workflow: str,
        commit_sha: str,
        pacing,
    ) -> ActionLogger.RestartStats:
        from datetime import timezone

        now = datetime.now(timezone.utc)
        has_win = any((now - t) < pacing for t in self._recent)
        total = len(self._recent)
        return ActionLogger.RestartStats(
            total_restarts=total,
            has_success_within_window=has_win,
            failures_since_last_success=0,
            secs_since_last_failure=10**9,
        )

    def insert_event(
        self,
        *,
        repo: str,
        ts: datetime,
        action: str,
        commit_sha: str,
        workflows: list[str],
        source_signal_keys: list[str],
        dry_run: bool,
        failed: bool,
        notes: str = "",
    ) -> None:
        self.insert_calls.append(
            (
                repo,
                ts,
                action,
                commit_sha,
                tuple(workflows),
                tuple(source_signal_keys),
                dry_run,
                failed,
                notes,
            )
        )


class FakeRestart:
    def restart_workflow(self, workflow_name: str, commit_sha: str) -> None:
        return None


class TestSignalActionsPacing(unittest.TestCase):
    def setUp(self) -> None:
        self.proc = SignalActionProcessor()
        # Inject fakes
        self.fake_logger = FakeLogger()
        self.proc._logger = self.fake_logger  # type: ignore[attr-defined]
        self.proc._restart = FakeRestart()  # type: ignore[attr-defined]
        self.ctx = RunContext(
            ts=datetime.now(timezone.utc),
            notify_issue_number=123456,
            repo_full_name="pytorch/pytorch",
            workflows=["trunk"],
            lookback_hours=24,
            # ensures no GH calls are made for revert; restarts do run
            revert_action=RevertAction.LOG,
            restart_action=RestartAction.RUN,
        )

    def test_skip_cap_when_two_recent(self):
        self.fake_logger._recent = [
            self.ctx.ts - timedelta(minutes=1),
            self.ctx.ts - timedelta(minutes=2),
        ]
        ok = self.proc.execute_restart(
            workflow_target="trunk",
            commit_sha="deadbeef",
            sources=[SignalMetadata(workflow_name="trunk", key="k")],
            ctx=self.ctx,
        )
        self.assertFalse(ok)
        self.assertEqual(len(self.fake_logger.insert_calls), 0)

    def test_skip_pacing_when_within_15min(self):
        self.fake_logger._recent = [self.ctx.ts - timedelta(minutes=5)]
        ok = self.proc.execute_restart(
            workflow_target="trunk",
            commit_sha="deadbeef",
            sources=[SignalMetadata(workflow_name="trunk", key="k")],
            ctx=self.ctx,
        )
        self.assertFalse(ok)
        self.assertEqual(len(self.fake_logger.insert_calls), 0)

    def test_allow_when_outside_pacing(self):
        self.fake_logger._recent = [self.ctx.ts - timedelta(minutes=20)]
        ok = self.proc.execute_restart(
            workflow_target="trunk",
            commit_sha="deadbeef",
            sources=[SignalMetadata(workflow_name="trunk", key="k")],
            ctx=self.ctx,
        )
        self.assertTrue(ok)
        self.assertEqual(len(self.fake_logger.insert_calls), 1)

    REVERT_MESSAGES = [
        (
            163276,
            """
            Revert "[opaque_obj] Add set_payload + docs (#163276)"
            This reverts commit dd30667.

            Reverted https://github.com/pytorch/pytorch/pull/163276 on behalf of https://github.com/ZainRizvi due to Sorry but this fails lint on trunk: [GH job link](https://github.com/pytorch/pytorch/actions/runs/17924886989/job/50968430537) [HUD commit link](https://hud.pytorch.org/pytorch/pytorch/commit/dd30667f6c2204a15e91eaeb61c84f9080be7748) ([comment](#163276 (comment)))
            """,
        ),
        (
            162310,
            """
            Revert "[BE] Update Python min version to 3.10 (#162310)"
            This reverts commit 9f5a644.

            Reverted https://github.com/pytorch/pytorch/pull/162310 on behalf of https://github.com/malfet due to Broke lint, but to the best of my knowledge it's no longer possible to run lint for all files on PRs ([comment](#162310 (comment)))
            """,
        ),
        (
            162659,
            """
            Revert "[BE] Make PyObjectSlot use a global PyInterpreter (#162659)"
            This reverts commit d1993c2.

            Reverted https://github.com/pytorch/pytorch/pull/162659 on behalf of https://github.com/wdvr due to reverted internally, please see D82771705 @PaliC ([comment](#162659 (comment)))
            """,
        ),
    ]
    MERGE_MESSAGES = [
        (
            163444,
            """
            Enable half precision types on test_conv_cudnn_nhwc_support (#163444)
            This PR adds flaot16 and bfloat16 cases to `test_conv_cudnn_nhwc_support` and removes outdated comments.
            Pull Request resolved: https://github.com/pytorch/pytorch/pull/163444
            Approved by: https://github.com/Skylion007
            """,
        ),
        (
            163440,
            """
            Remove workarounds for Python 3.6 (#163440)
            This PR removes tuple unpacking workarounds for Py 3.6 form two distributed files.

            Pull Request resolved: https://github.com/pytorch/pytorch/pull/163440
            Approved by: https://github.com/ezyang
            """,
        ),
        (
            163441,
            """
            [submodule] Bump libfmt to 12.0.0 (#163441)
            libfmt 12.0 brings new optimisations and fixes some compilation issues for clang 21 (fmtlib/fmt#4477).
            For a detailed release log, see https://github.com/fmtlib/fmt/releases/tag/12.0.0
            Pull Request resolved: https://github.com/pytorch/pytorch/pull/163441
            Approved by: https://github.com/Skylion007
            """,
        ),
    ]

    def test__commit_message_check_pr_is_revert(self):
        for i, msg in self.REVERT_MESSAGES:
            pr = self.proc._commit_message_check_pr_is_revert(msg, self.ctx)
            self.assertEqual(pr, i, f"Failed to match revert message {i}: {msg}")
        for i, msg in self.MERGE_MESSAGES:
            pr = self.proc._commit_message_check_pr_is_revert(msg, self.ctx)
            self.assertIsNone(pr, f"Incorrectly matched merge message {i}: {msg}")

    def test__commit_message_check_pr_is_merge(self):
        for i, msg in self.MERGE_MESSAGES:
            pr = self.proc._commit_message_check_pr_is_merge(msg, self.ctx)
            self.assertEqual(pr, i, f"Failed to match merge message {i}: {msg}")
        for i, msg in self.REVERT_MESSAGES:
            pr = self.proc._commit_message_check_pr_is_merge(msg, self.ctx)
            self.assertIsNone(pr, f"Incorrectly matched revert message {i}: {msg}")


class TestCommentIssueRevert(unittest.TestCase):
    def setUp(self) -> None:
        self.proc = SignalActionProcessor()
        self.fake_logger = FakeLogger()
        self.proc._logger = self.fake_logger  # type: ignore[attr-defined]
        self.ctx = RunContext(
            ts=datetime.now(timezone.utc),
            notify_issue_number=123456,
            repo_full_name="pytorch/pytorch",
            workflows=["trunk"],
            lookback_hours=24,
            revert_action=RevertAction.RUN_NOTIFY,
            restart_action=RestartAction.SKIP,
        )

    @patch("pytorch_auto_revert.signal_actions.GHClientFactory")
    def test_comment_no_pr_found(self, mock_gh_factory):
        """Test that method returns False when no PR is found for commit."""
        self.proc._find_pr_by_sha = Mock(return_value=None)

        sources = [
            SignalMetadata(
                workflow_name="trunk",
                key="test_signal",
                job_base_name="linux-jammy / test",
                wf_run_id=12345,
                job_id=67890,
            )
        ]

        result = self.proc._comment_issue_pr_revert("abc123", sources, self.ctx)

        self.assertFalse(result)
        mock_gh_factory.assert_not_called()

    @patch("pytorch_auto_revert.signal_actions.GHClientFactory")
    def test_comment_with_job_and_hud_links(self, mock_gh_factory):
        """Test that comment includes job link and HUD link when available."""
        # Mock PR and issue
        mock_pr = Mock()
        mock_pr.number = 12345
        mock_pr.get_labels.return_value = []

        mock_issue = Mock()
        mock_repo = Mock()
        mock_repo.get_issue.return_value = mock_issue
        mock_client = Mock()
        mock_client.get_repo.return_value = mock_repo
        mock_gh_factory.return_value.client = mock_client

        self.proc._find_pr_by_sha = Mock(
            return_value=(CommitPRSourceAction.MERGE, mock_pr)
        )

        sources = [
            SignalMetadata(
                workflow_name="trunk",
                key="test_signal",
                job_base_name="linux-jammy / test",
                wf_run_id=12345,
                job_id=67890,
            )
        ]

        result = self.proc._comment_issue_pr_revert("abc123", sources, self.ctx)

        self.assertTrue(result)

        # Verify issue comment was created
        mock_issue.create_comment.assert_called_once()
        comment_text = mock_issue.create_comment.call_args[0][0]

        # Check that job link is in the comment
        self.assertEqual(
            comment_text,
            "Autorevert detected a possible offender: abc123 from PR #12345.\n\nThe commit is a PR merge\n\nThis PR is attributed to have caused regression in:\n- trunk: [test_signal](https://github.com/pytorch/pytorch/actions/runs/12345/job/67890) ([hud](https://hud.pytorch.org/hud/pytorch/pytorch/abc123/1?per_page=50&name_filter=linux-jammy%20/%20test&mergeEphemeralLF=true))\n",
        )

    @patch("pytorch_auto_revert.signal_actions.GHClientFactory")
    def test_comment_with_job_without_hud_links(self, mock_gh_factory):
        """Test that comment includes job link but without HUD link."""
        # Mock PR and issue
        mock_pr = Mock()
        mock_pr.number = 12345
        mock_pr.get_labels.return_value = []

        mock_issue = Mock()
        mock_repo = Mock()
        mock_repo.get_issue.return_value = mock_issue
        mock_client = Mock()
        mock_client.get_repo.return_value = mock_repo
        mock_gh_factory.return_value.client = mock_client

        self.proc._find_pr_by_sha = Mock(
            return_value=(CommitPRSourceAction.MERGE, mock_pr)
        )

        sources = [
            SignalMetadata(
                workflow_name="trunk",
                key="test_signal",
                job_base_name=None,
                wf_run_id=12345,
                job_id=67890,
            )
        ]

        result = self.proc._comment_issue_pr_revert("abc123", sources, self.ctx)

        self.assertTrue(result)

        # Verify issue comment was created
        mock_issue.create_comment.assert_called_once()
        comment_text = mock_issue.create_comment.call_args[0][0]

        # Check that job link is in the comment
        self.assertEqual(
            comment_text,
            "Autorevert detected a possible offender: abc123 from PR #12345.\n\nThe commit is a PR merge\n\nThis PR is attributed to have caused regression in:\n- trunk: [test_signal](https://github.com/pytorch/pytorch/actions/runs/12345/job/67890)\n",
        )

    @patch("pytorch_auto_revert.signal_actions.GHClientFactory")
    def test_comment_without_job_info(self, mock_gh_factory):
        """Test that comment works without job_id/wf_run_id."""
        mock_pr = Mock()
        mock_pr.number = 12345
        mock_pr.get_labels.return_value = []

        mock_issue = Mock()
        mock_repo = Mock()
        mock_repo.get_issue.return_value = mock_issue
        mock_client = Mock()
        mock_client.get_repo.return_value = mock_repo
        mock_gh_factory.return_value.client = mock_client

        self.proc._find_pr_by_sha = Mock(
            return_value=(CommitPRSourceAction.MERGE, mock_pr)
        )

        sources = [
            SignalMetadata(
                workflow_name="trunk",
                key="test_signal",
                job_base_name="linux-jammy / test",
                wf_run_id=None,
                job_id=None,
            )
        ]

        result = self.proc._comment_issue_pr_revert("abc123", sources, self.ctx)

        self.assertTrue(result)

        # Verify issue comment was created
        mock_issue.create_comment.assert_called_once()
        comment_text = mock_issue.create_comment.call_args[0][0]

        # HUD link should still be present
        self.assertIn(
            "- trunk: test_signal ([hud](https://hud.pytorch.org/hud/pytorch/pytorch/abc123/1?per_page=50&name_filter=linux-jammy%20/%20test&mergeEphemeralLF=true))\n",
            comment_text,
        )

    @patch("pytorch_auto_revert.signal_actions.GHClientFactory")
    def test_comment_autorevert_disabled(self, mock_gh_factory):
        """Test that revert is not requested when autorevert is disabled."""
        mock_label = Mock()
        mock_label.name = "autorevert: disable"

        mock_pr = Mock()
        mock_pr.number = 12345
        mock_pr.labels = [mock_label]
        mock_pr.get_labels.return_value = [mock_label]

        mock_issue = Mock()
        mock_repo = Mock()
        mock_repo.get_issue.return_value = mock_issue
        mock_client = Mock()
        mock_client.get_repo.return_value = mock_repo
        mock_gh_factory.return_value.client = mock_client

        self.proc._find_pr_by_sha = Mock(
            return_value=(CommitPRSourceAction.MERGE, mock_pr)
        )

        # Use RUN_REVERT to test the disable logic
        ctx = RunContext(
            ts=datetime.now(timezone.utc),
            notify_issue_number=123456,
            repo_full_name="pytorch/pytorch",
            workflows=["trunk"],
            lookback_hours=24,
            revert_action=RevertAction.RUN_REVERT,
            restart_action=RestartAction.SKIP,
        )

        sources = [
            SignalMetadata(
                workflow_name="trunk",
                key="test_signal",
                job_base_name="linux-jammy / test",
                wf_run_id=12345,
                job_id=67890,
            )
        ]

        result = self.proc._comment_issue_pr_revert("abc123", sources, ctx)

        # Returns False because RUN_REVERT was requested but disabled by label
        self.assertFalse(result)

        # PR comment should not be created (revert disabled)
        mock_pr.create_issue_comment.assert_not_called()

        # Issue notification should still be created
        mock_issue.create_comment.assert_called_once()

    @patch("pytorch_auto_revert.signal_actions.GHClientFactory")
    def test_comment_multiple_workflows(self, mock_gh_factory):
        """Test that comment groups signals by workflow."""
        mock_pr = Mock()
        mock_pr.number = 12345
        mock_pr.get_labels.return_value = []

        mock_issue = Mock()
        mock_repo = Mock()
        mock_repo.get_issue.return_value = mock_issue
        mock_client = Mock()
        mock_client.get_repo.return_value = mock_repo
        mock_gh_factory.return_value.client = mock_client

        self.proc._find_pr_by_sha = Mock(
            return_value=(CommitPRSourceAction.MERGE, mock_pr)
        )

        sources = [
            SignalMetadata(
                workflow_name="trunk",
                key="test_signal_1",
                job_base_name="linux-jammy / test",
                wf_run_id=12345,
                job_id=67890,
            ),
            SignalMetadata(
                workflow_name="trunk",
                key="test_signal_2",
                job_base_name="linux-jammy / test",
                wf_run_id=12345,
                job_id=67890,
            ),
            SignalMetadata(
                workflow_name="inductor",
                key="test_inductor",
                job_base_name="linux-jammy / inductor",
                wf_run_id=None,
                job_id=None,
            ),
        ]

        result = self.proc._comment_issue_pr_revert("abc123", sources, self.ctx)

        self.assertTrue(result)

        # Verify issue comment was created
        mock_issue.create_comment.assert_called_once()
        comment_text = mock_issue.create_comment.call_args[0][0]

        # Check workflow grouping
        self.assertIn(
            "- trunk: [test_signal_1](https://github.com/pytorch/pytorch/actions/runs/12345/job/67890) ([hud](https://hud.pytorch.org/hud/pytorch/pytorch/abc123/1?per_page=50&name_filter=linux-jammy%20/%20test&mergeEphemeralLF=true)), [test_signal_2](https://github.com/pytorch/pytorch/actions/runs/12345/job/67890) ([hud](https://hud.pytorch.org/hud/pytorch/pytorch/abc123/1?per_page=50&name_filter=linux-jammy%20/%20test&mergeEphemeralLF=true))\n",
            comment_text,
        )
        self.assertIn(
            "- inductor: test_inductor ([hud](https://hud.pytorch.org/hud/pytorch/pytorch/abc123/1?per_page=50&name_filter=linux-jammy%20/%20inductor&mergeEphemeralLF=true))\n",
            comment_text,
        )


if __name__ == "__main__":
    unittest.main()
