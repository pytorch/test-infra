import time
import unittest
from unittest.mock import MagicMock, patch

from callback.callback_handler import handle
from utils.allowlist import AllowlistLevel
from utils.misc import CallbackState, DISPATCH_RUN_ID, HTTPException
from utils.redis_helper import CallbackStateRecord


def _cfg():
    cfg = MagicMock()
    cfg.hud_api_url = "http://hud/api/crcr-ci-events"
    cfg.hud_bot_key = "bot-key-123"
    cfg.redis_endpoint = "host:6379"
    cfg.redis_login = ""
    cfg.crcr_status_ttl = 259200
    cfg.rate_limit_per_min = 20
    cfg.upstream_repo = "pytorch/pytorch"
    return cfg


def _body(
    status="completed",
    workflow_name="default",
    run_id=99999,
    run_attempt=1,
    job_name=None,
    labels=None,
):
    wf = {
        "status": status,
        "conclusion": "success" if status == "completed" else None,
        "name": "CI",
        "url": "http://ci.example.com/run/1",
        "workflow_name": workflow_name,
        "run_id": run_id,
        "run_attempt": run_attempt,
    }
    if job_name is not None:
        wf["job_name"] = job_name

    return {
        "event_type": "pull_request",
        "delivery_id": "del-123",
        "payload": {
            "pull_request": {
                "number": 42,
                "head": {"sha": "abc123"},
                "labels": [{"name": n} for n in (labels or [])],
            },
            "repository": {"full_name": "pytorch/pytorch"},
        },
        "workflow": wf,
    }


class TestCallbackHandler(unittest.TestCase):
    def setUp(self):
        self.patcher_allowlist = patch("callback.callback_handler.load_allowlist")
        self.mock_load_allowlist = self.patcher_allowlist.start()
        mock_map = MagicMock()
        mock_map.get_repos_at_or_above_level.return_value = (["org/repo"], [])
        mock_map.get_repo_level.return_value = AllowlistLevel.L2
        self.mock_load_allowlist.return_value = mock_map

        self.patcher_redis = patch("callback.callback_handler.redis_helper")
        self.mock_redis = self.patcher_redis.start()
        self.mock_redis.create_client.return_value = MagicMock()

        # Setup default: dispatch exists, workflow state is None (in_progress not yet reported)
        def default_get_state(
            cfg,
            delivery_id,
            repo,
            run_id_arg,
            run_attempt_arg,
            client=None,
            job_name=None,
        ):
            if run_id_arg == DISPATCH_RUN_ID:
                return CallbackStateRecord(
                    CallbackState.DISPATCHED,
                    time.time() - 30,
                    {},
                )
            elif run_id_arg == 99999:  # default run_id in _body()
                return CallbackStateRecord(
                    CallbackState.IN_PROGRESS,
                    time.time() - 20,
                    {},
                )
            return None

        self.mock_redis.get_callback_state.side_effect = default_get_state

        self.patcher_rate_limit = patch("callback.callback_handler.check_rate_limit")
        self.mock_check_rate_limit = self.patcher_rate_limit.start()
        self.mock_check_rate_limit.return_value = True

        self.patcher_hud = patch("callback.callback_handler.forward_to_hud")
        self.mock_hud = self.patcher_hud.start()

    def tearDown(self):
        self.patcher_allowlist.stop()
        self.patcher_redis.stop()
        self.patcher_rate_limit.stop()
        self.patcher_hud.stop()

    # --- allowlist uses the OIDC-verified repo, not the body ---

    def test_verified_repo_not_in_l2_returns_ignored(self):
        mock_map = MagicMock()
        mock_map.get_repo_level.return_value = None
        self.mock_load_allowlist.return_value = mock_map

        result = handle(_cfg(), _body(), verified_repo="org/repo")

        self.assertEqual(result, {"ok": True, "status": "ignored"})
        self.assertFalse(self.mock_redis.create_client.called)
        self.assertFalse(self.mock_hud.called)

    # --- body is forwarded to HUD verbatim; verified_repo is a sibling ---

    def test_body_is_passed_to_hud_unchanged(self):
        body = _body()
        handle(_cfg(), body, verified_repo="org/repo")

        # forward_to_hud(config, trusted, untrusted)
        _, trusted_arg, untrusted_arg = self.mock_hud.call_args[0]
        self.assertIs(untrusted_arg["callback_payload"], body)
        self.assertEqual(trusted_arg.get("verified_repo"), "org/repo")
        # verified_repo is a sibling of ci_metrics, not nested inside it.
        self.assertNotIn("verified_repo", trusted_arg.get("ci_metrics", {}))

    # --- timing metrics calculation ---

    def test_queue_time_calculated_from_state_records(self):
        """queue_time is the dispatch-to-in_progress delta."""
        dispatch_record = CallbackStateRecord(
            CallbackState.DISPATCHED,
            1000.0,
            {},
        )
        workflow_record = CallbackStateRecord(
            CallbackState.IN_PROGRESS,
            1030.0,
            {},
        )
        self.mock_redis.get_callback_state.side_effect = [
            dispatch_record,  # dispatch lookup
            None,  # workflow state: not yet set
            workflow_record,  # re-read after set_callback_state
        ]

        handle(_cfg(), _body(status="in_progress"), verified_repo="org/repo")

        _, trusted_arg, _ = self.mock_hud.call_args[0]
        metrics = trusted_arg["ci_metrics"]
        self.assertEqual(metrics["queue_time"], 30.0)
        self.assertIsNone(metrics["execution_time"])

    def test_execution_time_calculated_from_state_records(self):
        """execution_time is the in_progress-to-completed delta."""
        dispatch_record = CallbackStateRecord(
            CallbackState.DISPATCHED,
            1000.0,
            {},
        )
        workflow_record = CallbackStateRecord(
            CallbackState.IN_PROGRESS,
            1030.0,
            {},
        )
        completed_record = CallbackStateRecord(
            CallbackState.COMPLETED,
            1060.0,
            {},
        )
        self.mock_redis.get_callback_state.side_effect = [
            dispatch_record,  # dispatch lookup
            workflow_record,  # workflow state: in_progress
            completed_record,  # re-read after set_callback_state
        ]

        handle(_cfg(), _body(status="completed"), verified_repo="org/repo")

        _, trusted_arg, _ = self.mock_hud.call_args[0]
        self.assertEqual(trusted_arg["ci_metrics"]["execution_time"], 30.0)

    # --- HUD 4xx propagates (5xx is swallowed inside forward_to_hud) ---

    def test_hud_4xx_propagates(self):
        self.mock_hud.side_effect = HTTPException(422, "bad schema")

        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), _body(), verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 422)

    # --- required field validation ---

    def test_missing_delivery_id_returns_400(self):
        body = _body()
        del body["delivery_id"]

        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), body, verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_missing_workflow_status_returns_400(self):
        body = _body()
        del body["workflow"]["status"]

        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), body, verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 400)

    # --- rate limiting ---

    def test_rate_limit_exceeded_returns_429(self):
        self.mock_check_rate_limit.return_value = False

        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), _body(), verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 429)
        self.assertFalse(self.mock_hud.called)

    # --- Redis outage during callback is tolerated ---

    def test_redis_error_fetching_dispatch_record_rejected(self):
        """Redis error on dispatch lookup returns None, causing 400 rejection."""
        self.mock_redis.get_callback_state.side_effect = [
            None,  # dispatch lookup returns None (get_callback_state catches RedisError)
        ]

        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), _body(status="completed"), verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_redis_error_fetching_workflow_record_proceeds(self):
        """Redis error on workflow record lookup returns None; callback proceeds."""
        dispatch_record = CallbackStateRecord(
            CallbackState.DISPATCHED,
            1000.0,
            {},
        )
        # Three calls: dispatch lookup, workflow record lookup, re-read after set.
        self.mock_redis.get_callback_state.side_effect = [
            dispatch_record,
            None,  # workflow record lookup returns None (get_callback_state catches RedisError)
            None,  # updated_workflow_record re-read → early return with empty metrics
        ]

        handle(_cfg(), _body(status="completed"), verified_repo="org/repo")

        _, trusted_arg, _ = self.mock_hud.call_args[0]
        self.assertIsNone(trusted_arg["ci_metrics"]["execution_time"])

    def test_job_name_passed_to_redis_state_calls(self):
        """job_name from callback body is forwarded to all Redis state calls."""
        dispatch_record = CallbackStateRecord(CallbackState.DISPATCHED, 1000.0, {})
        in_progress_record = CallbackStateRecord(CallbackState.IN_PROGRESS, 1030.0, {})
        self.mock_redis.get_callback_state.side_effect = [
            dispatch_record,
            None,
            in_progress_record,
        ]

        handle(
            _cfg(),
            _body(status="in_progress", job_name="build"),
            verified_repo="org/repo",
        )

        # set_callback_state should have been called with job_name="build"
        call_kwargs = self.mock_redis.set_callback_state.call_args
        self.assertEqual(call_kwargs.kwargs.get("job_name"), "build")

        # add_in_progress_tracker should have been called with job_name="build"
        tracker_kwargs = self.mock_redis.add_in_progress_tracker.call_args
        self.assertEqual(tracker_kwargs.kwargs.get("job_name"), "build")


class TestCallbackCheckRunUpdate(unittest.TestCase):
    """Upstream check run is updated when an L3/L4 downstream job completes."""

    def setUp(self):
        self.patcher_allowlist = patch("callback.callback_handler.load_allowlist")
        self.mock_load = self.patcher_allowlist.start()
        mock_map = MagicMock()
        mock_map.get_repo_level.return_value = AllowlistLevel.L4
        self.mock_load.return_value = mock_map

        self.patcher_redis = patch("callback.callback_handler.redis_helper")
        self.mock_redis = self.patcher_redis.start()

        def _get_state(
            cfg,
            delivery_id,
            repo,
            run_id_arg,
            run_attempt_arg,
            client=None,
            job_name=None,
        ):
            if run_id_arg == DISPATCH_RUN_ID:
                return CallbackStateRecord(CallbackState.DISPATCHED, 1000.0, {})
            if run_id_arg == 99999:  # default run_id in _body()
                return CallbackStateRecord(CallbackState.IN_PROGRESS, 1030.0, {})
            return None

        self.mock_redis.get_callback_state.side_effect = _get_state
        self.patcher_rate = patch("callback.callback_handler.check_rate_limit")
        self.mock_rate = self.patcher_rate.start()
        self.mock_rate.return_value = True

        self.patcher_hud = patch("callback.callback_handler.forward_to_hud")
        self.patcher_hud.start()

        self.patcher_gh = patch("callback.callback_handler.gh_helper")
        self.mock_gh = self.patcher_gh.start()
        self.mock_gh.get_repo_access_token.return_value = "tok"

    def tearDown(self):
        self.patcher_allowlist.stop()
        self.patcher_redis.stop()
        self.patcher_rate.stop()
        self.patcher_hud.stop()
        self.patcher_gh.stop()

    def test_completed_callback_creates_check_run(self):
        self.mock_gh.create_check_run.return_value = 888

        handle(_cfg(), _body(status="completed"), verified_repo="org/repo")

        self.mock_gh.create_check_run.assert_called_once()
        kw = self.mock_gh.create_check_run.call_args[1]
        self.assertEqual(kw["status"], "completed")
        self.assertEqual(kw["conclusion"], "success")

    def test_check_run_name_is_scoped_by_job_name(self):
        """The job_name from the callback body is threaded into the check run
        name so multiple jobs in one workflow run get distinct check runs."""
        self.mock_gh.create_check_run.return_value = 888

        handle(
            _cfg(),
            _body(status="completed", job_name="ec05-multi-job-a"),
            verified_repo="org/repo",
        )

        self.mock_gh.check_run_name.assert_called_once_with(
            "org/repo", "CI", "ec05-multi-job-a"
        )

    def test_check_run_external_id_is_run_id(self):
        """external_id carries the downstream run_id so a rerequest can re-run
        the failed jobs of that run."""
        self.mock_gh.create_check_run.return_value = 888

        handle(
            _cfg(),
            _body(status="completed", job_name="build"),
            verified_repo="org/repo",
        )

        kw = self.mock_gh.create_check_run.call_args[1]
        self.assertEqual(kw["external_id"], "99999")  # run_id from _body

    def test_in_progress_callback_creates_check_run(self):
        self.mock_gh.create_check_run.return_value = 999

        handle(_cfg(), _body(status="in_progress"), verified_repo="org/repo")

        self.mock_gh.create_check_run.assert_called_once()
        kw = self.mock_gh.create_check_run.call_args[1]
        self.assertEqual(kw["head_sha"], "abc123")
        self.assertEqual(kw["status"], "in_progress")

    def test_reopen_in_progress_creates_new_check_run(self):
        """Reopen scenario: prior completed CR exists; in_progress always creates a new one."""
        self.mock_gh.create_check_run.return_value = 999

        handle(_cfg(), _body(status="in_progress"), verified_repo="org/repo")

        self.mock_gh.create_check_run.assert_called_once()
        kw = self.mock_gh.create_check_run.call_args[1]
        self.assertEqual(kw["status"], "in_progress")

    def test_l3_with_matching_label_creates_check_run(self):
        """L3 repo: check run is created when needs_check_run returns True."""
        mock_map = MagicMock()
        mock_map.get_repo_level.return_value = AllowlistLevel.L3
        mock_map.needs_check_run.return_value = True
        self.mock_load.return_value = mock_map

        handle(_cfg(), _body(status="in_progress"), verified_repo="org/repo")

        self.mock_gh.create_check_run.assert_called_once()

    def test_l3_passes_body_labels_to_needs_check_run(self):
        """The PR labels from the callback body are extracted and handed to
        needs_check_run, which gates whether the L3 check run is created."""
        mock_map = MagicMock()
        mock_map.get_repo_level.return_value = AllowlistLevel.L3
        mock_map.needs_check_run.return_value = True
        self.mock_load.return_value = mock_map

        body = _body(status="in_progress", labels=["ciflow/crcr/device1", "other"])
        handle(_cfg(), body, verified_repo="org/repo")

        mock_map.needs_check_run.assert_called_once_with(
            "org/repo", {"ciflow/crcr/device1", "other"}
        )
        self.mock_gh.create_check_run.assert_called_once()

    def test_l3_without_label_does_not_create_check_run(self):
        """L3 repo: no check run when needs_check_run=False and no label trigger."""
        mock_map = MagicMock()
        mock_map.get_repo_level.return_value = AllowlistLevel.L3
        mock_map.needs_check_run.return_value = False
        self.mock_load.return_value = mock_map
        self.mock_redis.is_check_run_wanted.return_value = False

        handle(_cfg(), _body(status="in_progress"), verified_repo="org/repo")

        self.mock_gh.create_check_run.assert_not_called()

    def test_l3_check_run_wanted_flag_creates_check_run(self):
        """L3 reopen: echoed payload has no label, but the per-commit wanted flag
        (set at dispatch for this head_sha) makes the callback create the check run."""
        mock_map = MagicMock()
        mock_map.get_repo_level.return_value = AllowlistLevel.L3
        mock_map.needs_check_run.return_value = False
        self.mock_load.return_value = mock_map
        self.mock_redis.is_check_run_wanted.return_value = True

        handle(_cfg(), _body(status="in_progress"), verified_repo="org/repo")

        self.mock_gh.create_check_run.assert_called_once()
        self.mock_redis.is_check_run_wanted.assert_called_once_with(
            unittest.mock.ANY, "abc123", "org/repo"
        )

    def test_l2_completed_does_not_create_check_run(self):
        mock_map = MagicMock()
        mock_map.get_repo_level.return_value = AllowlistLevel.L2
        self.mock_load.return_value = mock_map

        handle(_cfg(), _body(status="completed"), verified_repo="org/repo")

        self.mock_gh.create_check_run.assert_not_called()

    def test_check_run_update_failure_does_not_break_response(self):
        self.mock_gh.get_repo_access_token.side_effect = RuntimeError("token error")

        result = handle(_cfg(), _body(status="completed"), verified_repo="org/repo")

        self.assertEqual(result, {"ok": True, "status": "completed"})


if __name__ == "__main__":
    unittest.main()
