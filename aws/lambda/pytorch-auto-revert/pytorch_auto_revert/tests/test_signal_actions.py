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
from pytorch_auto_revert.utils import AdvisorAction, RestartAction, RevertAction


# flake8: noqa


# ------------------------------
# Test helpers (to avoid duplication)
# ------------------------------


def setup_gh_mocks(
    mock_gh_factory, *, pr_number: int = 12345, state: str | None = None, labels=None
):
    """Set up common GitHub mocks and return (mock_pr, mock_issue).

    - Configures GHClientFactory().client.get_repo().get_issue() to return a mock issue
    - Creates a mock PR object with provided number/state/labels
    """
    if labels is None:
        labels = []

    mock_pr = Mock()
    mock_pr.number = pr_number
    if state is not None:
        mock_pr.state = state
    mock_pr.labels = labels
    mock_pr.get_labels.return_value = labels

    mock_issue = Mock()
    mock_repo = Mock()
    mock_repo.get_issue.return_value = mock_issue
    mock_client = Mock()
    mock_client.get_repo.return_value = mock_repo
    mock_gh_factory.return_value.client = mock_client

    return mock_pr, mock_issue


def make_ctx(*, revert_action, restart_action=RestartAction.SKIP):
    return RunContext(
        ts=datetime.now(timezone.utc),
        notify_issue_number=123456,
        repo_full_name="pytorch/pytorch",
        workflows=["trunk"],
        lookback_hours=24,
        revert_action=revert_action,
        restart_action=restart_action,
        advisor_action=AdvisorAction.SKIP,
    )


def make_source(
    *,
    workflow_name: str = "trunk",
    key: str = "test_signal",
    job_base_name: str | None = "linux-jammy / test",
    wf_run_id: int | None = 12345,
    job_id: int | None = 67890,
):
    return SignalMetadata(
        workflow_name=workflow_name,
        key=key,
        job_base_name=job_base_name,
        wf_run_id=wf_run_id,
        job_id=job_id,
    )


def set_find_pr_to_merge(proc: SignalActionProcessor, pr):
    proc._find_pr_by_sha = Mock(return_value=(CommitPRSourceAction.MERGE, pr))


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
            advisor_action=AdvisorAction.SKIP,
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
            advisor_action=AdvisorAction.SKIP,
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
        mock_pr, mock_issue = setup_gh_mocks(mock_gh_factory, pr_number=12345)
        set_find_pr_to_merge(self.proc, mock_pr)

        sources = [make_source()]

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
        mock_pr, mock_issue = setup_gh_mocks(mock_gh_factory, pr_number=12345)
        set_find_pr_to_merge(self.proc, mock_pr)

        sources = [make_source(job_base_name=None)]

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
        mock_pr, mock_issue = setup_gh_mocks(mock_gh_factory, pr_number=12345)
        set_find_pr_to_merge(self.proc, mock_pr)

        sources = [make_source(wf_run_id=None, job_id=None)]

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
        mock_pr, mock_issue = setup_gh_mocks(
            mock_gh_factory, pr_number=12345, labels=[mock_label]
        )
        set_find_pr_to_merge(self.proc, mock_pr)

        # Use RUN_REVERT to test the disable logic
        ctx = make_ctx(revert_action=RevertAction.RUN_REVERT)

        sources = [make_source()]

        result = self.proc._comment_issue_pr_revert("abc123", sources, ctx)

        # Returns False because RUN_REVERT was requested but disabled by label
        self.assertFalse(result)

        # PR comment should not be created (revert disabled)
        mock_pr.create_issue_comment.assert_not_called()

        # Issue notification should still be created
        mock_issue.create_comment.assert_called_once()

    @patch("pytorch_auto_revert.signal_actions.GHClientFactory")
    def test_comment_pr_open_fallback(self, mock_gh_factory):
        """When PR is open, do not request revert; just notify."""
        mock_pr, mock_issue = setup_gh_mocks(
            mock_gh_factory, pr_number=98765, state="open"
        )
        # Find PR by sha returns Merge action type, but PR is open; fallback to notify
        set_find_pr_to_merge(self.proc, mock_pr)

        # Use RUN_REVERT to ensure the code path would try a revert absent the open-state check
        ctx = make_ctx(revert_action=RevertAction.RUN_REVERT)

        sources = [make_source()]

        result = self.proc._comment_issue_pr_revert("abc123", sources, ctx)

        # Should not request pytorchbot revert when PR is open
        mock_pr.create_issue_comment.assert_not_called()
        # Should still post a notification comment
        mock_issue.create_comment.assert_called_once()
        # Return False because RUN_REVERT was requested but we fell back to notify-only
        self.assertFalse(result)

    @patch("pytorch_auto_revert.signal_actions.GHClientFactory")
    def test_comment_multiple_workflows(self, mock_gh_factory):
        """Test that comment groups signals by workflow."""
        mock_pr, mock_issue = setup_gh_mocks(mock_gh_factory, pr_number=12345)
        set_find_pr_to_merge(self.proc, mock_pr)

        sources = [
            make_source(key="test_signal_1"),
            make_source(key="test_signal_2"),
            make_source(
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


class FakeLoggerWithAdvisorDedup(FakeLogger):
    """FakeLogger that tracks advisor dedup checks."""

    def __init__(self, *, advisor_exists: bool = False, advisor_count: int = 0):
        super().__init__()
        self._advisor_exists = advisor_exists
        self._advisor_count = advisor_count

    def prior_advisor_exists(
        self, *, repo: str, commit_sha: str, signal_key: str
    ) -> bool:
        return self._advisor_exists

    def advisor_count_for_commit(
        self, *, repo: str, commit_sha: str, workflow: str
    ) -> int:
        return self._advisor_count


class TestExecuteAdvisor(unittest.TestCase):
    """Tests for SignalActionProcessor.execute_advisor."""

    def _make_signal_and_advisor(self):
        from datetime import datetime

        from pytorch_auto_revert.signal import (
            DispatchAdvisor,
            Signal,
            SignalCommit,
            SignalEvent,
            SignalSource,
            SignalStatus,
        )

        t0 = datetime(2025, 8, 19, 12, 0, 0)
        c_fail = SignalCommit(
            head_sha="sha_fail",
            timestamp=t0,
            events=[
                SignalEvent("job", SignalStatus.FAILURE, t0, wf_run_id=100, job_id=200),
                SignalEvent("job", SignalStatus.FAILURE, t0, wf_run_id=101, job_id=201),
            ],
        )
        c_base = SignalCommit(
            head_sha="sha_base",
            timestamp=t0,
            events=[
                SignalEvent("job", SignalStatus.SUCCESS, t0, wf_run_id=99, job_id=199),
            ],
        )
        signal = Signal(
            key="test_signal",
            workflow_name="trunk",
            commits=[c_fail, c_base],
            source=SignalSource.TEST,
        )
        advisor = DispatchAdvisor(
            suspect_commit="sha_fail",
            failed_commits=("sha_fail",),
            successful_commits=("sha_base",),
        )
        return signal, advisor

    def test_skip_when_action_is_skip(self):
        proc = SignalActionProcessor()
        proc._logger = FakeLoggerWithAdvisorDedup()
        signal, advisor = self._make_signal_and_advisor()
        ctx = RunContext(
            ts=datetime.now(timezone.utc),
            notify_issue_number=123456,
            repo_full_name="pytorch/pytorch",
            workflows=["trunk"],
            lookback_hours=24,
            revert_action=RevertAction.LOG,
            restart_action=RestartAction.SKIP,
            advisor_action=AdvisorAction.SKIP,
        )
        result = proc.execute_advisor(signal=signal, dispatch_advisor=advisor, ctx=ctx)
        self.assertFalse(result)
        self.assertEqual(len(proc._logger.insert_calls), 0)

    def test_skip_when_cap_reached(self):
        proc = SignalActionProcessor()
        proc._logger = FakeLoggerWithAdvisorDedup(advisor_count=8)
        signal, advisor = self._make_signal_and_advisor()
        ctx = RunContext(
            ts=datetime.now(timezone.utc),
            notify_issue_number=123456,
            repo_full_name="pytorch/pytorch",
            workflows=["trunk"],
            lookback_hours=24,
            revert_action=RevertAction.LOG,
            restart_action=RestartAction.SKIP,
            advisor_action=AdvisorAction.RUN,
        )
        result = proc.execute_advisor(signal=signal, dispatch_advisor=advisor, ctx=ctx)
        self.assertFalse(result)
        self.assertEqual(len(proc._logger.insert_calls), 0)

    def test_skip_when_prior_advisor_exists(self):
        proc = SignalActionProcessor()
        proc._logger = FakeLoggerWithAdvisorDedup(advisor_exists=True)
        signal, advisor = self._make_signal_and_advisor()
        ctx = RunContext(
            ts=datetime.now(timezone.utc),
            notify_issue_number=123456,
            repo_full_name="pytorch/pytorch",
            workflows=["trunk"],
            lookback_hours=24,
            revert_action=RevertAction.LOG,
            restart_action=RestartAction.SKIP,
            advisor_action=AdvisorAction.RUN,
        )
        result = proc.execute_advisor(signal=signal, dispatch_advisor=advisor, ctx=ctx)
        self.assertFalse(result)
        self.assertEqual(len(proc._logger.insert_calls), 0)

    @patch("pytorch_auto_revert.signal_actions.GHClientFactory")
    def test_log_mode_inserts_event_without_dispatch(self, mock_gh_factory):
        proc = SignalActionProcessor()
        proc._logger = FakeLoggerWithAdvisorDedup()
        proc._find_pr_by_sha = Mock(return_value=None)
        signal, advisor = self._make_signal_and_advisor()
        ctx = RunContext(
            ts=datetime.now(timezone.utc),
            notify_issue_number=123456,
            repo_full_name="pytorch/pytorch",
            workflows=["trunk"],
            lookback_hours=24,
            revert_action=RevertAction.LOG,
            restart_action=RestartAction.SKIP,
            advisor_action=AdvisorAction.LOG,
        )
        result = proc.execute_advisor(signal=signal, dispatch_advisor=advisor, ctx=ctx)
        self.assertTrue(result)
        self.assertEqual(len(proc._logger.insert_calls), 1)
        call = proc._logger.insert_calls[0]
        # call is (repo, ts, action, commit_sha, workflows, signal_keys, dry_run, failed, notes)
        self.assertEqual(call[2], "advisor")  # action
        self.assertEqual(call[3], "sha_fail")  # commit_sha
        self.assertTrue(call[6])  # dry_run=True for LOG mode
        # No GitHub dispatch should have been called
        mock_gh_factory.assert_not_called()

    @patch("pytorch_auto_revert.signal_actions.proper_workflow_create_dispatch")
    @patch("pytorch_auto_revert.signal_actions.GHClientFactory")
    def test_run_mode_dispatches_and_logs(self, mock_gh_factory, mock_dispatch):
        proc = SignalActionProcessor()
        proc._logger = FakeLoggerWithAdvisorDedup()
        mock_pr = Mock()
        mock_pr.number = 42
        proc._find_pr_by_sha = Mock(return_value=(CommitPRSourceAction.MERGE, mock_pr))

        mock_repo = Mock()
        mock_workflow = Mock()
        mock_repo.get_workflow.return_value = mock_workflow
        mock_gh_factory.return_value.client.get_repo.return_value = mock_repo

        signal, advisor = self._make_signal_and_advisor()
        ctx = RunContext(
            ts=datetime.now(timezone.utc),
            notify_issue_number=123456,
            repo_full_name="pytorch/pytorch",
            workflows=["trunk"],
            lookback_hours=24,
            revert_action=RevertAction.LOG,
            restart_action=RestartAction.SKIP,
            advisor_action=AdvisorAction.RUN,
        )
        result = proc.execute_advisor(signal=signal, dispatch_advisor=advisor, ctx=ctx)
        self.assertTrue(result)
        # Verify dispatch was called
        mock_dispatch.assert_called_once()
        dispatch_args = mock_dispatch.call_args
        self.assertEqual(dispatch_args[1]["ref"], "main")
        inputs = dispatch_args[1]["inputs"]
        self.assertEqual(inputs["suspect_commit"], "sha_fail")
        self.assertEqual(inputs["pr_number"], "42")
        self.assertIn("signal_key", inputs["signal_pattern"])
        # Verify CH event logged
        self.assertEqual(len(proc._logger.insert_calls), 1)
        call = proc._logger.insert_calls[0]
        self.assertEqual(call[2], "advisor")
        self.assertFalse(call[6])  # dry_run=False for RUN mode


class TestBuildSignalPatternJson(unittest.TestCase):
    """Tests for SignalActionProcessor._build_signal_pattern_json."""

    def test_flattened_structure(self):
        import json

        from pytorch_auto_revert.signal import (
            DispatchAdvisor,
            Signal,
            SignalCommit,
            SignalEvent,
            SignalSource,
            SignalStatus,
        )

        t0 = datetime(2025, 8, 19, 12, 0, 0)
        t1 = datetime(2025, 8, 19, 11, 0, 0)
        t2 = datetime(2025, 8, 19, 10, 0, 0)
        t3 = datetime(2025, 8, 19, 9, 0, 0)

        c_fail = SignalCommit(
            head_sha="sha_fail",
            timestamp=t0,
            events=[
                SignalEvent("job", SignalStatus.FAILURE, t0, wf_run_id=100, job_id=200),
            ],
        )
        c_base = SignalCommit(
            head_sha="sha_base",
            timestamp=t1,
            events=[
                SignalEvent("job", SignalStatus.SUCCESS, t1, wf_run_id=99, job_id=199),
            ],
        )
        c_prior = SignalCommit(
            head_sha="sha_prior",
            timestamp=t2,
            events=[
                SignalEvent("job", SignalStatus.FAILURE, t2, wf_run_id=98, job_id=198),
            ],
        )
        c_oldest = SignalCommit(
            head_sha="sha_oldest",
            timestamp=t3,
            events=[],
        )

        signal = Signal(
            key="test_key",
            workflow_name="trunk",
            commits=[c_fail, c_base, c_prior, c_oldest],
            source=SignalSource.TEST,
            job_base_name="linux-jammy / test",
        )
        advisor = DispatchAdvisor(
            suspect_commit="sha_fail",
            failed_commits=("sha_fail",),
            successful_commits=("sha_base",),
        )

        result_json = SignalActionProcessor._build_signal_pattern_json(
            signal=signal,
            dispatch_advisor=advisor,
            repo_full_name="pytorch/pytorch",
        )
        result = json.loads(result_json)

        # Top-level metadata
        self.assertEqual(result["signal_key"], "test_key")
        self.assertEqual(result["signal_source"], "test")
        self.assertEqual(result["workflow_name"], "trunk")
        self.assertEqual(result["job_base_name"], "linux-jammy / test")
        self.assertEqual(result["commit_order"], "newest_first")
        self.assertEqual(result["suspect_commit"], "sha_fail")

        # Should have all 4 commits
        self.assertEqual(len(result["commits"]), 4)

        # Check partition labels
        commits = {c["sha"]: c for c in result["commits"]}
        self.assertIn("failed", commits["sha_fail"]["partition"])
        self.assertTrue(commits["sha_fail"]["is_suspect"])
        self.assertIn("successful", commits["sha_base"]["partition"])
        self.assertFalse(commits["sha_base"]["is_suspect"])
        self.assertIn("prior", commits["sha_prior"]["partition"])
        self.assertIn("prior", commits["sha_oldest"]["partition"])

        # Check event URLs are present for events with job_id
        fail_events = commits["sha_fail"]["events"]
        self.assertEqual(len(fail_events), 1)
        self.assertEqual(fail_events[0]["status"], "failure")
        self.assertIn("url", fail_events[0])
        self.assertIn("log_url", fail_events[0])
        self.assertIn("200", fail_events[0]["url"])

        # Check success events also have URLs
        base_events = commits["sha_base"]["events"]
        self.assertEqual(len(base_events), 1)
        self.assertEqual(base_events[0]["status"], "success")
        self.assertIn("url", base_events[0])

        # Timestamps are human-readable
        self.assertIn("UTC", commits["sha_fail"]["timestamp"])

    def test_unknown_partition_label(self):
        """Commits between failed and successful partitions get 'unknown' label."""
        import json

        from pytorch_auto_revert.signal import (
            DispatchAdvisor,
            Signal,
            SignalCommit,
            SignalEvent,
            SignalSource,
            SignalStatus,
        )

        t0 = datetime(2025, 8, 19, 12, 0, 0)
        t1 = datetime(2025, 8, 19, 11, 0, 0)
        t2 = datetime(2025, 8, 19, 10, 0, 0)

        c_fail = SignalCommit(
            head_sha="sha_fail",
            timestamp=t0,
            events=[SignalEvent("j", SignalStatus.FAILURE, t0, wf_run_id=1, job_id=1)],
        )
        c_gap = SignalCommit(
            head_sha="sha_gap",
            timestamp=t1,
            events=[],
        )
        c_base = SignalCommit(
            head_sha="sha_base",
            timestamp=t2,
            events=[SignalEvent("j", SignalStatus.SUCCESS, t2, wf_run_id=2, job_id=2)],
        )

        signal = Signal(
            key="k",
            workflow_name="wf",
            commits=[c_fail, c_gap, c_base],
            source=SignalSource.TEST,
        )
        advisor = DispatchAdvisor(
            suspect_commit="sha_fail",
            failed_commits=("sha_fail",),
            successful_commits=("sha_base",),
        )

        result = json.loads(
            SignalActionProcessor._build_signal_pattern_json(
                signal=signal,
                dispatch_advisor=advisor,
                repo_full_name="o/r",
            )
        )
        commits = {c["sha"]: c for c in result["commits"]}
        self.assertIn("unknown", commits["sha_gap"]["partition"])

    def test_signal_pattern_sanity_check(self):
        """Sanity check: all required keys present, events ordered, timestamps valid."""
        import json

        from pytorch_auto_revert.signal import (
            DispatchAdvisor,
            Signal,
            SignalCommit,
            SignalEvent,
            SignalSource,
            SignalStatus,
        )

        t0 = datetime(2025, 8, 19, 12, 0, 0)
        t1 = datetime(2025, 8, 19, 11, 0, 0)
        t2 = datetime(2025, 8, 19, 10, 0, 0)
        t3 = datetime(2025, 8, 19, 9, 0, 0)

        # Build a signal with all partition types and multiple events per commit
        c_fail = SignalCommit(
            head_sha="aaa111",
            timestamp=t0,
            events=[
                SignalEvent(
                    "ev1",
                    SignalStatus.FAILURE,
                    t0,
                    wf_run_id=10,
                    job_id=20,
                    ended_at=t0,
                    run_attempt=1,
                ),
                SignalEvent(
                    "ev2",
                    SignalStatus.FAILURE,
                    t1,
                    wf_run_id=11,
                    job_id=21,
                    ended_at=t1,
                    run_attempt=2,
                ),
            ],
        )
        c_base = SignalCommit(
            head_sha="bbb222",
            timestamp=t1,
            events=[
                SignalEvent("ev3", SignalStatus.SUCCESS, t2, wf_run_id=8, job_id=18),
            ],
        )
        c_prior_fail = SignalCommit(
            head_sha="ccc333",
            timestamp=t2,
            events=[
                SignalEvent("ev4", SignalStatus.FAILURE, t3, wf_run_id=5, job_id=15),
            ],
        )
        c_prior_empty = SignalCommit(
            head_sha="ddd444",
            timestamp=t3,
            events=[],
        )

        signal = Signal(
            key="test/foo.py::test_bar",
            workflow_name="trunk",
            commits=[c_fail, c_base, c_prior_fail, c_prior_empty],
            source=SignalSource.TEST,
            job_base_name="linux-jammy / test",
        )
        advisor = DispatchAdvisor(
            suspect_commit="aaa111",
            failed_commits=("aaa111",),
            successful_commits=("bbb222",),
        )

        raw = SignalActionProcessor._build_signal_pattern_json(
            signal=signal,
            dispatch_advisor=advisor,
            repo_full_name="pytorch/pytorch",
        )
        result = json.loads(raw)

        # Top-level required keys
        for key in (
            "signal_key",
            "signal_source",
            "workflow_name",
            "commit_order",
            "suspect_commit",
            "commits",
        ):
            self.assertIn(key, result, f"Missing top-level key: {key}")

        self.assertEqual(result["signal_key"], "test/foo.py::test_bar")
        self.assertEqual(result["signal_source"], "test")
        self.assertEqual(result["commit_order"], "newest_first")
        self.assertEqual(result["suspect_commit"], "aaa111")
        self.assertEqual(result["job_base_name"], "linux-jammy / test")

        # All commits present in order (newest first)
        shas = [c["sha"] for c in result["commits"]]
        self.assertEqual(shas, ["aaa111", "bbb222", "ccc333", "ddd444"])

        # Partition labels
        commits = {c["sha"]: c for c in result["commits"]}
        self.assertIn("failed", commits["aaa111"]["partition"])
        self.assertTrue(commits["aaa111"]["is_suspect"])
        self.assertIn("successful", commits["bbb222"]["partition"])
        self.assertFalse(commits["bbb222"]["is_suspect"])
        self.assertIn("prior", commits["ccc333"]["partition"])
        self.assertIn("prior", commits["ddd444"]["partition"])

        # Events ordered oldest-first within each commit (as per SignalCommit)
        fail_events = commits["aaa111"]["events"]
        self.assertEqual(len(fail_events), 2)
        # Events should have started_at as strings with "UTC"
        for ev in fail_events:
            self.assertIn("UTC", ev["started_at"])
            self.assertIn("status", ev)
            self.assertIn("job_id", ev)
            self.assertIn("wf_run_id", ev)

        # URLs present for events with job_id
        for ev in fail_events:
            if ev["job_id"]:
                self.assertIn("url", ev)
                self.assertIn("log_url", ev)
                self.assertIn("pytorch/pytorch", ev["url"])

        # Success events also have URLs
        base_events = commits["bbb222"]["events"]
        self.assertEqual(len(base_events), 1)
        self.assertIn("url", base_events[0])

        # Prior commit with events has URLs
        prior_events = commits["ccc333"]["events"]
        self.assertEqual(len(prior_events), 1)
        self.assertIn("url", prior_events[0])

        # Empty commit has no events
        self.assertEqual(len(commits["ddd444"]["events"]), 0)

        # Timestamps are human-readable
        for c in result["commits"]:
            if c["timestamp"]:
                self.assertIn("UTC", c["timestamp"])

        # JSON is valid and re-parseable
        reparsed = json.loads(json.dumps(result))
        self.assertEqual(reparsed, result)


class TestDispatchAdvisorsMethod(unittest.TestCase):
    """Tests for SignalActionProcessor.dispatch_advisors."""

    def _make_signal_with_advisor(self, key="sig1", commit="sha1"):
        from pytorch_auto_revert.signal import (
            DispatchAdvisor,
            Ineligible,
            IneligibleReason,
            RestartCommits,
            Signal,
            SignalCommit,
            SignalEvent,
            SignalSource,
            SignalStatus,
        )

        t0 = datetime(2025, 8, 19, 12, 0, 0)
        advisor = DispatchAdvisor(
            suspect_commit=commit,
            failed_commits=(commit,),
            successful_commits=("base",),
        )
        signal = Signal(
            key=key,
            workflow_name="trunk",
            commits=[
                SignalCommit(
                    commit,
                    t0,
                    [
                        SignalEvent(
                            "j", SignalStatus.FAILURE, t0, wf_run_id=1, job_id=1
                        ),
                    ],
                ),
                SignalCommit(
                    "base",
                    t0,
                    [
                        SignalEvent(
                            "j", SignalStatus.SUCCESS, t0, wf_run_id=2, job_id=2
                        ),
                    ],
                ),
            ],
            source=SignalSource.TEST,
        )
        outcome = RestartCommits(commit_shas={commit}, advisor=advisor)
        return signal, outcome

    def _make_signal_without_advisor(self, key="no_advisor"):
        from pytorch_auto_revert.signal import (
            Ineligible,
            IneligibleReason,
            Signal,
            SignalCommit,
            SignalEvent,
            SignalSource,
            SignalStatus,
        )

        t0 = datetime(2025, 8, 19, 12, 0, 0)
        signal = Signal(
            key=key,
            workflow_name="trunk",
            commits=[SignalCommit("x", t0, [])],
            source=SignalSource.TEST,
        )
        outcome = Ineligible(IneligibleReason.FLAKY, "flaky")
        return signal, outcome

    def test_skip_mode_returns_empty(self):
        proc = SignalActionProcessor()
        proc._logger = FakeLoggerWithAdvisorDedup()
        s1, o1 = self._make_signal_with_advisor()
        ctx = RunContext(
            ts=datetime.now(timezone.utc),
            notify_issue_number=123456,
            repo_full_name="pytorch/pytorch",
            workflows=["trunk"],
            lookback_hours=24,
            revert_action=RevertAction.LOG,
            restart_action=RestartAction.SKIP,
            advisor_action=AdvisorAction.SKIP,
        )
        result = proc.dispatch_advisors([(s1, o1)], ctx)
        self.assertEqual(result, [])

    @patch("pytorch_auto_revert.signal_actions.GHClientFactory")
    def test_dispatches_only_eligible_signals(self, mock_gh):
        proc = SignalActionProcessor()
        proc._logger = FakeLoggerWithAdvisorDedup()
        proc._find_pr_by_sha = Mock(return_value=None)
        s1, o1 = self._make_signal_with_advisor(key="eligible")
        s2, o2 = self._make_signal_without_advisor(key="ineligible")
        ctx = RunContext(
            ts=datetime.now(timezone.utc),
            notify_issue_number=123456,
            repo_full_name="pytorch/pytorch",
            workflows=["trunk"],
            lookback_hours=24,
            revert_action=RevertAction.LOG,
            restart_action=RestartAction.SKIP,
            advisor_action=AdvisorAction.LOG,
        )
        result = proc.dispatch_advisors([(s1, o1), (s2, o2)], ctx)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["signal_key"], "trunk:eligible")

    @patch("pytorch_auto_revert.signal_actions.GHClientFactory")
    def test_dispatch_metadata_format(self, mock_gh):
        proc = SignalActionProcessor()
        proc._logger = FakeLoggerWithAdvisorDedup()
        proc._find_pr_by_sha = Mock(return_value=None)
        s1, o1 = self._make_signal_with_advisor(key="test_key", commit="abc123")
        ctx = RunContext(
            ts=datetime.now(timezone.utc),
            notify_issue_number=123456,
            repo_full_name="pytorch/pytorch",
            workflows=["trunk"],
            lookback_hours=24,
            revert_action=RevertAction.LOG,
            restart_action=RestartAction.SKIP,
            advisor_action=AdvisorAction.LOG,
        )
        result = proc.dispatch_advisors([(s1, o1)], ctx)
        self.assertEqual(len(result), 1)
        d = result[0]
        self.assertEqual(d["signal_key"], "trunk:test_key")
        self.assertEqual(d["commit_sha"], "abc123")
        self.assertEqual(d["workflow_name"], "trunk")
        self.assertEqual(d["mode"], "log")


if __name__ == "__main__":
    unittest.main()
