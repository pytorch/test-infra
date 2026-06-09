import unittest
import unittest.mock
from unittest.mock import MagicMock, patch

from webhook.event_handler import handle


def _cfg():
    cfg = MagicMock()
    cfg.github_app_id = "12345"
    cfg.github_app_private_key = "fake-key"
    cfg.max_dispatch_workers = 4
    cfg.github_app_secret = "test-secret"
    cfg.upstream_repo = "pytorch/pytorch"
    cfg.oot_status_ttl = 259200
    return cfg


def _payload(action="synchronize"):
    return {
        "action": action,
        "repository": {"full_name": "pytorch/pytorch"},
        "pull_request": {
            "head": {"sha": "abc123", "ref": "feat"},
            "base": {"ref": "main"},
            "number": 42,
            "labels": [],
        },
        "installation": {"id": 99},
    }


def _payload_with_labels(action="synchronize", labels=None):
    payload = _payload(action)
    payload["pull_request"]["labels"] = [{"name": n} for n in (labels or [])]
    return payload


class TestEventHandler(unittest.TestCase):
    def test_ignored_action(self):
        self.assertEqual(
            handle(_cfg(), _payload(action="assigned"), "pull_request", "delivery-1"),
            {"ignored": True},
        )

    @patch("webhook.event_handler.redis_helper.mark_check_run_wanted")
    @patch("webhook.event_handler.redis_helper.set_callback_state")
    @patch("webhook.event_handler.gh_helper.create_repository_dispatch")
    @patch("webhook.event_handler.gh_helper.get_repo_access_token", return_value="tok")
    @patch("webhook.event_handler.load_allowlist")
    def test_dispatch_success(self, mock_load, _tok, mock_dispatch, _state, _trig):
        mock_map = MagicMock()
        mock_map.get_repos_at_or_above_level.return_value = (["org/a"], [])
        mock_load.return_value = mock_map
        result = handle(_cfg(), _payload(action="opened"), "pull_request", "delivery-1")
        self.assertTrue(result["ok"])
        mock_dispatch.assert_called_once()

    @patch("webhook.event_handler.redis_helper.mark_check_run_wanted")
    @patch("webhook.event_handler.redis_helper.set_callback_state")
    @patch("webhook.event_handler.gh_helper.create_repository_dispatch")
    @patch(
        "webhook.event_handler.gh_helper.get_repo_access_token",
        side_effect=["tok-a", "tok-b"],
    )
    @patch("webhook.event_handler.load_allowlist")
    def test_dispatch_mints_token_per_downstream_repo(
        self, mock_load, mock_get_repo_access_token, mock_dispatch, _state, _trig
    ):
        mock_map = MagicMock()
        mock_map.get_repos_at_or_above_level.return_value = (
            ["huawei/repo", "pytorch/repo"],
            [],
        )
        mock_load.return_value = mock_map

        result = handle(_cfg(), _payload(action="opened"), "pull_request", "delivery-2")

        self.assertTrue(result["ok"])
        # One token per downstream repo for dispatch only; CR creation moved to callback
        self.assertEqual(mock_get_repo_access_token.call_count, 2)
        mock_get_repo_access_token.assert_any_call("12345", "fake-key", "huawei/repo")
        mock_get_repo_access_token.assert_any_call("12345", "fake-key", "pytorch/repo")
        self.assertEqual(mock_dispatch.call_count, 2)


class TestDispatchCheckRunCreation(unittest.TestCase):
    """Check runs are never created at dispatch time; the callback creates them."""

    @patch("webhook.event_handler.redis_helper.mark_check_run_wanted")
    @patch("webhook.event_handler.redis_helper.set_callback_state")
    @patch("webhook.event_handler.gh_helper.create_check_run")
    @patch("webhook.event_handler.gh_helper.create_repository_dispatch")
    @patch("webhook.event_handler.gh_helper.get_repo_access_token", return_value="tok")
    @patch("webhook.event_handler.load_allowlist")
    def test_l3_with_crcr_label_does_not_create_check_run_at_dispatch(
        self, mock_load, _tok, _dispatch, mock_create_cr, _state, _trig
    ):
        """L3 with a matching label does not create a CR at dispatch; the in_progress callback does."""
        mock_map = MagicMock()
        mock_map.get_repos_at_or_above_level.return_value = (["org/repo"], [])
        mock_load.return_value = mock_map

        handle(
            _cfg(),
            _payload_with_labels(labels=["ciflow/crcr/device"]),
            "pull_request",
            "del-1",
        )

        mock_create_cr.assert_not_called()

    @patch("webhook.event_handler.redis_helper.mark_check_run_wanted")
    @patch("webhook.event_handler.redis_helper.set_callback_state")
    @patch("webhook.event_handler.gh_helper.create_check_run")
    @patch("webhook.event_handler.gh_helper.create_repository_dispatch")
    @patch("webhook.event_handler.gh_helper.get_repo_access_token", return_value="tok")
    @patch("webhook.event_handler.load_allowlist")
    def test_l4_does_not_create_check_run_at_dispatch(
        self, mock_load, _tok, _dispatch, mock_create_cr, _state, _trig
    ):
        """L4 does not create a CR at dispatch; the in_progress callback does."""
        mock_map = MagicMock()
        mock_map.get_repos_at_or_above_level.return_value = (["org/repo"], [])
        mock_load.return_value = mock_map

        handle(_cfg(), _payload(), "pull_request", "del-2")

        mock_create_cr.assert_not_called()


class TestPrLabeledHandler(unittest.TestCase):
    """pull_request.labeled with ciflow/crcr/* triggers L3 check run backfill."""

    def _labeled_payload(self, label="ciflow/crcr/device"):
        return {
            "action": "labeled",
            "label": {"name": label},
            "pull_request": {
                "number": 42,
                "head": {"sha": "abc123"},
                "labels": [{"name": label}],
            },
            "repository": {"full_name": "pytorch/pytorch"},
        }

    def setUp(self):
        self.patcher_redis = patch("webhook.event_handler.redis_helper")
        self.mock_redis = self.patcher_redis.start()

        self.patcher_gh = patch("webhook.event_handler.gh_helper")
        self.mock_gh = self.patcher_gh.start()
        self.mock_gh.get_repo_access_token.return_value = "tok"
        self.mock_gh.create_check_run.return_value = 77
        self.patcher_load = patch("webhook.event_handler.load_allowlist")
        self.mock_load = self.patcher_load.start()
        mock_map = MagicMock()
        mock_map.get_repos_for_device.return_value = (["org/l3repo"], [])
        self.mock_load.return_value = mock_map

    def tearDown(self):
        self.patcher_redis.stop()
        self.patcher_gh.stop()
        self.patcher_load.stop()

    def test_scenario2_in_progress_job_creates_in_progress_check_run(self):
        """Scenario 2: label arrives while workflow is in_progress → backfill in_progress CR."""
        self.mock_redis.get_dispatch_workflow.return_value = {
            "status": "in_progress",
            "check_run_id": "555",
            "conclusion": None,
            "job_url": "https://github.com/org/l3repo/actions/runs/99999",
            "run_id": "99999",
            "workflow_name": "CI",
        }

        result = handle(_cfg(), self._labeled_payload(), "pull_request", "label-del")

        self.assertTrue(result["ok"])
        self.assertIn("org/l3repo", result["created_check_runs"])
        self.mock_gh.create_check_run.assert_called_once()
        kw = self.mock_gh.create_check_run.call_args[1]
        self.assertEqual(kw["head_sha"], "abc123")
        self.assertNotIn("conclusion", kw)

    def test_scenario3_completed_job_creates_completed_check_run(self):
        """Scenario 3: label arrives after workflow completed → create completed CR directly."""
        self.mock_redis.get_dispatch_workflow.return_value = {
            "status": "completed",
            "check_run_id": "555",
            "conclusion": "success",
            "job_url": "https://github.com/org/l3repo/actions/runs/99999",
            "run_id": "99999",
            "workflow_name": "CI",
        }

        result = handle(_cfg(), self._labeled_payload(), "pull_request", "label-del")

        self.assertTrue(result["ok"])
        self.assertIn("org/l3repo", result["created_check_runs"])
        kw = self.mock_gh.create_check_run.call_args[1]
        self.assertEqual(kw["status"], "completed")
        self.assertEqual(kw["conclusion"], "success")

    def test_no_job_info_marks_check_run_wanted(self):
        """No job info yet → mark check run wanted so the callback creates it when it fires."""
        self.mock_redis.get_dispatch_workflow.return_value = None

        result = handle(_cfg(), self._labeled_payload(), "pull_request", "label-del")

        self.assertTrue(result["ok"])
        self.assertEqual(result["created_check_runs"], [])
        self.mock_gh.create_check_run.assert_not_called()
        self.mock_redis.mark_check_run_wanted.assert_called_once_with(
            unittest.mock.ANY, "abc123", "org/l3repo"
        )

    def test_non_crcr_label_is_ignored(self):
        result = handle(
            _cfg(),
            self._labeled_payload(label="some/other/label"),
            "pull_request",
            "del-x",
        )
        self.assertEqual(result, {"ignored": True})


if __name__ == "__main__":
    unittest.main()
