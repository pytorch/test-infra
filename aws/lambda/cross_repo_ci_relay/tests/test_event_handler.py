import unittest
import unittest.mock
from unittest.mock import MagicMock, patch

from utils.allowlist import AllowlistLevel
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
            ["org1/repo", "pytorch/repo"],
            [],
        )
        mock_load.return_value = mock_map

        result = handle(_cfg(), _payload(action="opened"), "pull_request", "delivery-2")

        self.assertTrue(result["ok"])
        # One token per downstream repo for dispatch only; CR creation moved to callback
        self.assertEqual(mock_get_repo_access_token.call_count, 2)
        mock_get_repo_access_token.assert_any_call("12345", "fake-key", "org1/repo")
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

    def _job(self, job_name="ci", status="in_progress", conclusion=None, run_id="99999"):
        return {
            "status": status,
            "conclusion": conclusion,
            "job_url": "https://github.com/org/l3repo/actions/runs/99999",
            "run_id": run_id,
            "workflow_name": "CI",
            "job_name": job_name,
        }

    def test_scenario2_in_progress_job_creates_in_progress_check_run(self):
        """Scenario 2: label arrives while workflow is in_progress → backfill in_progress CR."""
        self.mock_redis.get_dispatch_jobs.return_value = [self._job(status="in_progress")]

        result = handle(_cfg(), self._labeled_payload(), "pull_request", "label-del")

        self.assertTrue(result["ok"])
        self.assertIn("org/l3repo/ci", result["created_check_runs"])
        self.mock_gh.create_check_run.assert_called_once()
        kw = self.mock_gh.create_check_run.call_args[1]
        self.assertEqual(kw["head_sha"], "abc123")
        self.assertEqual(kw["status"], "in_progress")
        self.assertIsNone(kw["conclusion"])
        self.assertEqual(kw["external_id"], "99999")  # run_id

    def test_scenario2_backfills_every_job_not_just_one(self):
        """Multi-job workflow: a mid-run label backfills a check run for EVERY
        cached job, not only the last one that reported."""
        self.mock_redis.get_dispatch_jobs.return_value = [
            self._job(job_name="ci"),
            self._job(job_name="ci-2"),
        ]

        result = handle(_cfg(), self._labeled_payload(), "pull_request", "label-del")

        self.assertEqual(
            set(result["created_check_runs"]), {"org/l3repo/ci", "org/l3repo/ci-2"}
        )
        self.assertEqual(self.mock_gh.create_check_run.call_count, 2)
        # gh_helper.check_run_name is mocked, so assert it was asked to build a
        # name for each job; jobs of the same run share run_id as external_id.
        job_names = {c.args[2] for c in self.mock_gh.check_run_name.call_args_list}
        self.assertEqual(job_names, {"ci", "ci-2"})
        external_ids = {
            c.kwargs["external_id"]
            for c in self.mock_gh.create_check_run.call_args_list
        }
        self.assertEqual(external_ids, {"99999"})  # run_id

    def test_scenario3_completed_job_creates_completed_check_run(self):
        """Scenario 3: label arrives after workflow completed → create completed CR directly."""
        self.mock_redis.get_dispatch_jobs.return_value = [
            self._job(status="completed", conclusion="success")
        ]

        result = handle(_cfg(), self._labeled_payload(), "pull_request", "label-del")

        self.assertTrue(result["ok"])
        self.assertIn("org/l3repo/ci", result["created_check_runs"])
        kw = self.mock_gh.create_check_run.call_args[1]
        self.assertEqual(kw["status"], "completed")
        self.assertEqual(kw["conclusion"], "success")

    def test_upstream_token_minted_once_for_multiple_repos(self):
        """A device mapping to multiple repos mints the upstream token once, not per repo."""
        self.mock_load.return_value.get_repos_for_device.return_value = (
            ["org/repoA", "org/repoB"],
            [],
        )
        self.mock_redis.get_dispatch_jobs.return_value = [
            self._job(status="completed", conclusion="success")
        ]

        result = handle(_cfg(), self._labeled_payload(), "pull_request", "label-del")

        self.assertEqual(
            set(result["created_check_runs"]), {"org/repoA/ci", "org/repoB/ci"}
        )
        self.assertEqual(self.mock_gh.get_repo_access_token.call_count, 1)
        self.assertEqual(self.mock_gh.create_check_run.call_count, 2)

    def test_no_job_info_marks_check_run_wanted(self):
        """No job info yet → mark check run wanted so the callback creates it when it fires."""
        self.mock_redis.get_dispatch_jobs.return_value = []

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


class TestCheckRunRerun(unittest.TestCase):
    """check_run rerequested re-runs the failed jobs of the run by its run_id."""

    def setUp(self):
        self.patcher_gh = patch("webhook.event_handler.gh_helper")
        self.mock_gh = self.patcher_gh.start()
        self.mock_gh.get_repo_access_token.return_value = "tok"

        self.patcher_redis = patch("webhook.event_handler.redis_helper")
        self.mock_redis = self.patcher_redis.start()

        self.patcher_load = patch("webhook.event_handler.load_allowlist")
        self.mock_load = self.patcher_load.start()
        self.mock_map = MagicMock()
        self.mock_map.get_repo_level.return_value = AllowlistLevel.L3
        self.mock_map.get_repos_at_or_above_level.return_value = (["org/l3repo"], [])
        self.mock_load.return_value = self.mock_map

    def tearDown(self):
        self.patcher_gh.stop()
        self.patcher_redis.stop()
        self.patcher_load.stop()

    def _check_run_payload(self, name="crcr/org/l3repo/CI/build", external_id="88888"):
        return {
            "action": "rerequested",
            "check_run": {
                "name": name,
                "external_id": external_id,
                "head_sha": "abc123",
            },
            "repository": {"full_name": "pytorch/pytorch"},
        }

    def test_check_run_rerequested_reruns_failed_jobs_of_run(self):
        result = handle(_cfg(), self._check_run_payload(), "check_run", "del-1")
        self.assertEqual(result, {"ok": True, "rerun": ["org/l3repo"]})
        self.mock_gh.rerun_failed_jobs.assert_called_once_with(
            token="tok", repo_full_name="org/l3repo", run_id=88888
        )

    def test_check_run_already_running_is_benign(self):
        """A 403 'already running' is not surfaced as an error (no 502)."""
        self.mock_gh.rerun_failed_jobs.side_effect = Exception(
            "The workflow run containing this job is already running: 403"
        )
        result = handle(_cfg(), self._check_run_payload(), "check_run", "del-1b")
        self.assertTrue(result["ok"])
        self.assertTrue(result["already_running"])

    def test_non_crcr_check_run_is_ignored(self):
        result = handle(
            _cfg(),
            self._check_run_payload(name="some-other-check"),
            "check_run",
            "del-2",
        )
        self.assertTrue(result["ignored"])
        self.mock_gh.rerun_failed_jobs.assert_not_called()

    def test_check_run_without_external_id_is_ignored(self):
        """No run_id stored -> nothing to rerun, not an error."""
        result = handle(
            _cfg(),
            self._check_run_payload(external_id=""),
            "check_run",
            "del-2b",
        )
        self.assertTrue(result["ignored"])
        self.mock_gh.rerun_failed_jobs.assert_not_called()

    def test_check_run_non_rerequested_action_ignored(self):
        payload = self._check_run_payload()
        payload["action"] = "created"
        self.assertEqual(
            handle(_cfg(), payload, "check_run", "del-3"), {"ignored": True}
        )
        self.mock_gh.rerun_failed_jobs.assert_not_called()

    def test_check_suite_rerequested_reruns_each_distinct_run(self):
        """The suite-level "re-run all" button re-runs the failed jobs of every
        distinct run; jobs sharing a run_id are deduped to one call."""
        self.mock_gh.list_check_runs_in_suite.return_value = [
            {"name": "crcr/org/l3repo/CI/build", "external_id": "111"},
            {"name": "crcr/org/l3repo/CI/test", "external_id": "111"},  # same run
            {"name": "crcr/org/l3repo/Lint/lint", "external_id": "222"},
        ]
        payload = {
            "action": "rerequested",
            "check_suite": {"id": 9001, "head_sha": "abc123"},
            "repository": {"full_name": "pytorch/pytorch"},
        }
        result = handle(_cfg(), payload, "check_suite", "del-4")

        self.assertEqual(result, {"ok": True, "rerun": ["org/l3repo", "org/l3repo"]})
        self.assertEqual(self.mock_gh.rerun_failed_jobs.call_count, 2)
        run_ids = {
            c.kwargs["run_id"] for c in self.mock_gh.rerun_failed_jobs.call_args_list
        }
        self.assertEqual(run_ids, {111, 222})

    def test_check_suite_already_running_run_is_skipped(self):
        """A run that's already running is skipped, others still re-run."""
        self.mock_gh.list_check_runs_in_suite.return_value = [
            {"name": "crcr/org/l3repo/CI/build", "external_id": "111"},
            {"name": "crcr/org/l3repo/Lint/lint", "external_id": "222"},
        ]

        def _side_effect(*, token, repo_full_name, run_id):
            if run_id == 111:
                raise Exception("workflow run ... is already running: 403")

        self.mock_gh.rerun_failed_jobs.side_effect = _side_effect
        payload = {
            "action": "rerequested",
            "check_suite": {"id": 9001, "head_sha": "abc123"},
            "repository": {"full_name": "pytorch/pytorch"},
        }
        result = handle(_cfg(), payload, "check_suite", "del-4b")
        self.assertEqual(result, {"ok": True, "rerun": ["org/l3repo"]})

    def test_check_suite_skips_non_crcr_and_missing_external_id(self):
        """Non-crcr check runs and ones without a run_id are skipped, not errored."""
        self.mock_gh.list_check_runs_in_suite.return_value = [
            {"name": "some-other-check", "external_id": "999"},
            {"name": "crcr/org/l3repo/CI/build", "external_id": ""},
        ]
        payload = {
            "action": "rerequested",
            "check_suite": {"id": 9002, "head_sha": "abc123"},
            "repository": {"full_name": "pytorch/pytorch"},
        }
        result = handle(_cfg(), payload, "check_suite", "del-5")
        self.assertEqual(result, {"ok": True, "rerun": []})
        self.mock_gh.rerun_failed_jobs.assert_not_called()

    def test_check_suite_non_rerequested_action_ignored(self):
        payload = {
            "action": "completed",
            "check_suite": {"id": 9003},
            "repository": {"full_name": "pytorch/pytorch"},
        }
        self.assertEqual(
            handle(_cfg(), payload, "check_suite", "del-6"), {"ignored": True}
        )
        self.mock_gh.rerun_failed_jobs.assert_not_called()


if __name__ == "__main__":
    unittest.main()
