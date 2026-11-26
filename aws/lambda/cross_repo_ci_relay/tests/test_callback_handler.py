import time
import unittest
from unittest.mock import MagicMock, patch

from callback.callback_handler import handle
from utils.allowlist import AllowlistLevel, CrcrEvent
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


def _push_body(status="in_progress", ref="refs/tags/ciflow/trunk/42", after="abc123"):
    return {
        "event_type": "push",
        "delivery_id": "del-123",
        "payload": {
            "ref": ref,
            "after": after,
            "repository": {"full_name": "pytorch/pytorch"},
        },
        "workflow": {
            "status": status,
            "conclusion": "success" if status == "completed" else None,
            "name": "CI",
            "url": "http://ci.example.com/run/1",
            "workflow_name": "default",
            "run_id": 99999,
            "run_attempt": 1,
        },
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

        # Default: this job is treated as the first (and only, i.e. winning)
        # job in its run. Tests exercising multiple jobs in one run override
        # this explicitly.
        self.mock_redis.record_workflow_started.side_effect = lambda *a, **kw: (
            a[5],
            True,
        )

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

    # --- queue_time is workflow-level (only the first job to start reports it) ---

    def test_queue_time_uses_first_jobs_start_for_a_later_job(self):
        """A later job (e.g. "test", waiting on a "build" job) that somehow
        still won the marker would get queue_time anchored to the first
        job's start, not its own (later) in_progress time -- otherwise the
        wait on "build" would inflate its queue_time."""
        dispatch_record = CallbackStateRecord(CallbackState.DISPATCHED, 1000.0, {})
        self.mock_redis.get_callback_state.side_effect = [
            dispatch_record,  # dispatch lookup
            None,  # workflow state: not yet set
            CallbackStateRecord(CallbackState.IN_PROGRESS, 1030.0, {}),  # re-read
        ]
        self.mock_redis.record_workflow_started.side_effect = None
        self.mock_redis.record_workflow_started.return_value = (1030.0, True)

        handle(
            _cfg(),
            _body(status="in_progress", job_name="build"),
            verified_repo="org/repo",
        )

        _, trusted_arg, _ = self.mock_hud.call_args[0]
        self.assertEqual(trusted_arg["ci_metrics"]["queue_time"], 30.0)

    def test_queue_time_is_none_for_a_later_job_that_lost_the_marker(self):
        """A later job (e.g. "test", waiting on a "build" job) that reads back
        an earlier job's workflow-start marker (won=False) reports
        queue_time=None -- only the winning job reports a sample, so a
        multi-job run doesn't skew averages by contributing one row per job."""
        dispatch_record = CallbackStateRecord(CallbackState.DISPATCHED, 1000.0, {})
        # This job reports in_progress at 1200, but the "build" job already
        # claimed the workflow-start marker at 1030.
        self.mock_redis.get_callback_state.side_effect = [
            dispatch_record,  # dispatch lookup
            None,  # workflow state: not yet set
            CallbackStateRecord(CallbackState.IN_PROGRESS, 1200.0, {}),  # re-read
        ]
        self.mock_redis.record_workflow_started.side_effect = None
        self.mock_redis.record_workflow_started.return_value = (1030.0, False)

        handle(
            _cfg(),
            _body(status="in_progress", job_name="test"),
            verified_repo="org/repo",
        )

        _, trusted_arg, _ = self.mock_hud.call_args[0]
        self.assertIsNone(trusted_arg["ci_metrics"]["queue_time"])

    def test_execution_time_unaffected_by_workflow_level_queue_time(self):
        """execution_time stays purely job-level (in_progress -> completed for
        this same job) and completed callbacks never touch the workflow-start
        marker -- that's only relevant to in_progress/queue_time."""
        dispatch_record = CallbackStateRecord(CallbackState.DISPATCHED, 1000.0, {})
        workflow_record = CallbackStateRecord(CallbackState.IN_PROGRESS, 1200.0, {})
        completed_record = CallbackStateRecord(CallbackState.COMPLETED, 1260.0, {})
        self.mock_redis.get_callback_state.side_effect = [
            dispatch_record,
            workflow_record,
            completed_record,
        ]

        handle(
            _cfg(),
            _body(status="completed", job_name="test"),
            verified_repo="org/repo",
        )

        _, trusted_arg, _ = self.mock_hud.call_args[0]
        self.assertEqual(trusted_arg["ci_metrics"]["execution_time"], 60.0)
        self.mock_redis.record_workflow_started.assert_not_called()

    # --- HUD 4xx propagates (5xx is swallowed inside forward_to_hud) ---

    def test_hud_4xx_propagates(self):
        self.mock_hud.side_effect = HTTPException(422, "bad schema")

        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), _body(), verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 422)

    def test_pr_duplicate_returns_ok_duplicate(self):
        # Write-once guard on HUD returns 409 for completed → completed
        # replays. PR/push path should treat that as a soft duplicate, same
        # as the nightly handler (nightly is the primary write-once use case;
        # this is the matching backstop for the shared HUD API).
        self.mock_hud.side_effect = HTTPException(409, "Record already finalized")

        result = handle(_cfg(), _body(status="completed"), verified_repo="org/repo")

        self.assertEqual(result, {"ok": True, "status": "duplicate"})

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
        self.assertEqual(ctx.exception.headers, {"Retry-After": "3"})
        self.assertFalse(self.mock_hud.called)

    def test_hud_429_is_passed_through_without_retry_after(self):
        # Only the relay's own limit carries Retry-After; reporters must not
        # retry a HUD 429, which arrives after the state write.
        self.mock_hud.side_effect = HTTPException(429, "HUD rejected callback")

        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), _body(), verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 429)
        self.assertEqual(ctx.exception.headers, {})

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
        self.mock_redis.record_workflow_started.side_effect = lambda *a, **kw: (
            a[5],
            True,
        )

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

        # Not on temporary demotion unless a test says so.
        self.patcher_since = patch(
            "utils.redis_helper.get_demotion_since", return_value=None
        )
        self.mock_since = self.patcher_since.start()

    def tearDown(self):
        self.patcher_allowlist.stop()
        self.patcher_redis.stop()
        self.patcher_rate.stop()
        self.patcher_hud.stop()
        self.patcher_gh.stop()
        self.patcher_since.stop()

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
        self.assertEqual(kw["external_id"], "99999:42")  # run_id:pr_number

    def test_in_progress_callback_creates_check_run(self):
        self.mock_gh.create_check_run.return_value = 999

        handle(_cfg(), _body(status="in_progress"), verified_repo="org/repo")

        self.mock_gh.create_check_run.assert_called_once()
        kw = self.mock_gh.create_check_run.call_args[1]
        self.assertEqual(kw["head_sha"], "abc123")
        self.assertEqual(kw["status"], "in_progress")

    def test_push_ciflow_trunk_l4_creates_check_run(self):
        """The headline bug: a push-triggered L4 run must still get an
        upstream check run, resolving head_sha/pr_number from the ref."""
        self.mock_gh.create_check_run.return_value = 999

        handle(_cfg(), _push_body(), verified_repo="org/repo")

        self.mock_gh.create_check_run.assert_called_once()
        kw = self.mock_gh.create_check_run.call_args[1]
        self.assertEqual(kw["head_sha"], "abc123")
        self.assertEqual(kw["external_id"], "99999:42")  # run_id:pr_number

    def test_push_to_main_skips_check_run_and_cache(self):
        """A plain push to main (the merge landing itself) has no PR to
        attach a check run to, and nothing will ever look up a cache entry
        keyed by a merge commit's SHA, so neither happens."""
        result = handle(
            _cfg(), _push_body(ref="refs/heads/main"), verified_repo="org/repo"
        )

        self.assertEqual(result, {"ok": True, "status": "in_progress"})
        self.mock_gh.create_check_run.assert_not_called()
        self.mock_redis.set_dispatch_job.assert_not_called()

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

    def _l3(self):
        mock_map = MagicMock()
        mock_map.get_repo_level.return_value = AllowlistLevel.L3
        mock_map.needs_check_run.return_value = True
        self.mock_load.return_value = mock_map

    def test_l3_new_job_gets_no_check_run_while_its_demotion_pr_is_open(self):
        self._l3()
        self.mock_since.return_value = 500.0
        # run 12345 has no earlier record: a job that starts now.
        body = _body(status="in_progress", run_id=12345)

        result = handle(_cfg(), body, verified_repo="org/repo")

        self.mock_gh.create_check_run.assert_not_called()
        # It still reports to HUD as before.
        self.assertEqual(result, {"ok": True, "status": "in_progress"})

    def test_l3_job_started_before_the_demotion_still_gets_its_check_run(self):
        """Its check run may already show in progress, so it has to be finished."""
        self._l3()
        # The in-progress record says this job started at 1030.0.
        self.mock_since.return_value = 2000.0

        handle(_cfg(), _body(status="completed"), verified_repo="org/repo")

        self.mock_gh.create_check_run.assert_called_once()

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


class TestCallbackTriageVerdict(unittest.TestCase):
    """The optional triage verdict is validated before anything consumes it."""

    def setUp(self):
        self.patcher_allowlist = patch("callback.callback_handler.load_allowlist")
        mock_map = MagicMock()
        mock_map.get_repo_level.return_value = AllowlistLevel.L3
        mock_map.needs_check_run.return_value = True
        self.patcher_allowlist.start().return_value = mock_map

        self.patcher_redis = patch("callback.callback_handler.redis_helper")
        self.mock_redis = self.patcher_redis.start()
        self.mock_redis.record_workflow_started.side_effect = lambda *a, **kw: (
            a[5],
            True,
        )

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
            return CallbackStateRecord(CallbackState.IN_PROGRESS, 1030.0, {})

        self.mock_redis.get_callback_state.side_effect = _get_state

        self.patcher_rate = patch("callback.callback_handler.check_rate_limit")
        self.patcher_rate.start().return_value = True

        self.patcher_hud = patch("callback.callback_handler.forward_to_hud")
        self.mock_hud = self.patcher_hud.start()

        self.patcher_gh = patch("callback.callback_handler.gh_helper")
        self.mock_gh = self.patcher_gh.start()
        self.mock_gh.get_repo_access_token.return_value = "tok"
        self.mock_gh.create_check_run.return_value = 888

    def tearDown(self):
        for patcher in (
            self.patcher_allowlist,
            self.patcher_redis,
            self.patcher_rate,
            self.patcher_hud,
            self.patcher_gh,
        ):
            patcher.stop()

    def _body_with(self, verdict):
        body = _body(status="completed", job_name="build-npu")
        body["workflow"]["triage_verdict"] = verdict
        return body

    def _valid(self, **overrides):
        verdict = {
            "schema_version": 1,
            "category": "upstream",
            "confidence": "high",
            "summary": "aten::foo lost its out= overload.",
        }
        verdict.update(overrides)
        return verdict

    def _forwarded_workflow(self):
        _, _, untrusted = self.mock_hud.call_args[0]
        return untrusted["callback_payload"]["workflow"]

    def test_valid_verdict_reaches_hud(self):
        handle(_cfg(), self._body_with(self._valid()), verified_repo="org/repo")

        self.assertEqual(self._forwarded_workflow()["triage_verdict"], self._valid())

    def test_verdict_is_normalized_before_being_forwarded(self):
        # HUD must never see the raw object: unknown keys and over-long values
        # are what the size caps here exist to keep out of its records.
        body = self._body_with(
            self._valid(summary="s" * 5000, undeclared_field="x" * 5000)
        )
        handle(_cfg(), body, verified_repo="org/repo")

        forwarded = self._forwarded_workflow()["triage_verdict"]
        self.assertNotIn("undeclared_field", forwarded)
        self.assertEqual(len(forwarded["summary"]), 1000)

    def test_invalid_verdict_is_dropped_and_the_callback_still_succeeds(self):
        result = handle(
            _cfg(),
            self._body_with(self._valid(category="cosmic-rays")),
            verified_repo="org/repo",
        )

        self.assertEqual(result, {"ok": True, "status": "completed"})
        self.assertNotIn("triage_verdict", self._forwarded_workflow())

    def test_no_verdict_leaves_the_payload_untouched(self):
        handle(
            _cfg(),
            _body(status="completed", job_name="build"),
            verified_repo="org/repo",
        )

        self.assertNotIn("triage_verdict", self._forwarded_workflow())


class TestNightlyCallback(unittest.TestCase):
    """Nightly/periodic callbacks bypass the state machine entirely."""

    def setUp(self):
        self.patcher_allowlist = patch("callback.callback_handler.load_allowlist")
        self.mock_load = self.patcher_allowlist.start()
        mock_map = MagicMock()
        mock_map.get_repo_level.return_value = AllowlistLevel.L2
        self.mock_load.return_value = mock_map

        self.patcher_redis = patch("callback.callback_handler.redis_helper")
        self.mock_redis = self.patcher_redis.start()

        self.patcher_rate = patch("callback.callback_handler.check_rate_limit")
        self.mock_rate = self.patcher_rate.start()
        self.mock_rate.return_value = True

        self.patcher_hud = patch("callback.callback_handler.forward_to_hud")
        self.mock_hud = self.patcher_hud.start()

    def tearDown(self):
        self.patcher_allowlist.stop()
        self.patcher_redis.stop()
        self.patcher_rate.stop()
        self.patcher_hud.stop()

    def _nightly_body(
        self, event_type="nightly", status="completed", conclusion="success"
    ):
        return {
            "event_type": event_type,
            "delivery_id": "abc123def456",
            "payload": {},
            "workflow": {
                "status": status,
                "conclusion": conclusion,
                "name": "CRCR Nightly CI",
                "url": "https://github.com/org/repo/actions/runs/12345",
                "run_id": "12345",
                "run_attempt": "1",
                "job_name": "nightly-build",
                "check_run_id": "67890",
            },
        }

    def test_nightly_callback_forwards_to_hud(self):
        body = self._nightly_body()
        result = handle(_cfg(), body, verified_repo="org/repo")

        self.assertEqual(result, {"ok": True, "status": "completed"})
        self.mock_hud.assert_called_once()
        _, trusted, untrusted = self.mock_hud.call_args[0]
        self.assertEqual(trusted["verified_repo"], "org/repo")
        self.assertIs(untrusted["callback_payload"], body)

    def test_nightly_callback_skips_redis(self):
        handle(_cfg(), self._nightly_body(), verified_repo="org/repo")

        self.mock_redis.get_callback_state.assert_not_called()
        self.mock_redis.set_callback_state.assert_not_called()
        self.mock_redis.add_in_progress_tracker.assert_not_called()
        self.mock_redis.remove_in_progress_tracker.assert_not_called()
        self.mock_redis.record_workflow_started.assert_not_called()

    def test_nightly_callback_has_no_timing_metrics(self):
        handle(_cfg(), self._nightly_body(), verified_repo="org/repo")

        _, trusted, _ = self.mock_hud.call_args[0]
        self.assertIsNone(trusted["ci_metrics"]["queue_time"])
        self.assertIsNone(trusted["ci_metrics"]["execution_time"])

    def test_periodic_callback_also_works(self):
        body = self._nightly_body(event_type="periodic")
        result = handle(_cfg(), body, verified_repo="org/repo")

        self.assertEqual(result, {"ok": True, "status": "completed"})
        self.mock_hud.assert_called_once()

    def test_nightly_rejects_in_progress_status(self):
        body = self._nightly_body(status="in_progress")
        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), body, verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("completed", str(ctx.exception.detail))

    def test_nightly_not_in_allowlist_is_ignored(self):
        mock_map = MagicMock()
        mock_map.get_repo_level.return_value = None
        self.mock_load.return_value = mock_map

        result = handle(_cfg(), self._nightly_body(), verified_repo="unknown/repo")

        self.assertEqual(result, {"ok": True, "status": "ignored"})
        self.mock_hud.assert_not_called()

    def test_nightly_rate_limited(self):
        self.mock_rate.return_value = False

        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), self._nightly_body(), verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 429)

    def test_nightly_missing_delivery_id_returns_400(self):
        body = self._nightly_body()
        del body["delivery_id"]

        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), body, verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_nightly_verdict_is_validated_before_forwarding(self):
        body = self._nightly_body(conclusion="failure")
        body["workflow"]["triage_verdict"] = {
            "schema_version": 1,
            "category": "infra",
            "confidence": "medium",
            "summary": "device allocation timed out",
            "undeclared_field": "x",
        }
        handle(_cfg(), body, verified_repo="org/repo")

        _, _, untrusted = self.mock_hud.call_args[0]
        forwarded = untrusted["callback_payload"]["workflow"]["triage_verdict"]
        self.assertNotIn("undeclared_field", forwarded)
        self.assertEqual(forwarded["category"], "infra")

    def test_nightly_invalid_verdict_is_dropped(self):
        body = self._nightly_body()
        body["workflow"]["triage_verdict"] = {"category": "upstream"}
        handle(_cfg(), body, verified_repo="org/repo")

        _, _, untrusted = self.mock_hud.call_args[0]
        self.assertNotIn("triage_verdict", untrusted["callback_payload"]["workflow"])

    def test_nightly_failure_conclusion_forwards(self):
        body = self._nightly_body()
        body["workflow"]["conclusion"] = "failure"
        result = handle(_cfg(), body, verified_repo="org/repo")

        self.assertEqual(result, {"ok": True, "status": "completed"})
        self.mock_hud.assert_called_once()
        _, trusted, untrusted = self.mock_hud.call_args[0]
        self.assertEqual(
            untrusted["callback_payload"]["workflow"]["conclusion"], "failure"
        )

    def test_nightly_duplicate_returns_ok_duplicate(self):
        self.mock_hud.side_effect = HTTPException(409, "Record already finalized")

        result = handle(_cfg(), self._nightly_body(), verified_repo="org/repo")

        self.assertEqual(result, {"ok": True, "status": "duplicate"})

    def test_nightly_hud_non_409_error_propagates(self):
        self.mock_hud.side_effect = HTTPException(500, "Internal error")

        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), self._nightly_body(), verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 500)


class TestReleaseCallback(unittest.TestCase):
    """A run against a release candidate reports like a nightly, naming its tag."""

    SHA = "a" * 40

    def setUp(self):
        self.mock_map = MagicMock()
        self.mock_map.get_repo_level.return_value = AllowlistLevel.L2
        self.mock_map.get_repo_events.return_value = frozenset({CrcrEvent.RELEASE})
        patchers = {
            "load": patch("callback.callback_handler.load_allowlist"),
            "redis": patch("callback.callback_handler.redis_helper"),
            "rate": patch("callback.callback_handler.check_rate_limit"),
            "hud": patch("callback.callback_handler.forward_to_hud"),
            "lookup": patch(
                "callback.callback_handler.gh_helper.get_tag_commit",
                return_value=self.SHA,
            ),
            "token": patch(
                "callback.callback_handler.gh_helper.get_repo_access_token",
                return_value="installation-token",
            ),
        }
        self.mocks = {}
        for name, patcher in patchers.items():
            self.mocks[name] = patcher.start()
            self.addCleanup(patcher.stop)
        self.mocks["load"].return_value = self.mock_map
        self.mocks["rate"].return_value = True

    def _body(self, status="completed", **extra):
        return {
            "event_type": "release",
            "delivery_id": self.SHA,
            "release_tag": "v2.16.0-rc9",
            "payload": {
                "repository": {"full_name": "pytorch/pytorch"},
                "head_sha": self.SHA,
            },
            "workflow": {
                "status": status,
                "conclusion": "success" if status == "completed" else None,
                "name": "Release CI",
                "url": "https://github.com/org/repo/actions/runs/12345",
                "run_id": "12345",
                "run_attempt": "1",
                "job_name": "tests",
                "check_run_id": "67890",
            },
            **extra,
        }

    def test_the_release_and_the_candidate_are_forwarded_as_trusted(self):
        body = self._body()
        result = handle(_cfg(), body, verified_repo="org/repo")

        self.assertEqual(result, {"ok": True, "status": "completed"})
        self.mocks["hud"].assert_called_once()
        _, trusted, untrusted = self.mocks["hud"].call_args[0]
        self.assertEqual(trusted["verified_repo"], "org/repo")
        self.assertEqual(trusted["release"], "2.16.0")
        self.assertEqual(trusted["rc"], "rc9")
        self.assertIs(untrusted["callback_payload"], body)

    def test_the_tag_is_looked_up_on_the_upstream_repo(self):
        handle(_cfg(), self._body(), verified_repo="org/repo")

        self.mocks["lookup"].assert_called_once_with(
            token="installation-token",
            repo_full_name="pytorch/pytorch",
            tag="v2.16.0-rc9",
        )

    def test_the_release_tag_has_an_empty_rc(self):
        handle(_cfg(), self._body(release_tag="v2.15.1"), verified_repo="org/repo")

        _, trusted, _ = self.mocks["hud"].call_args[0]
        self.assertEqual((trusted["release"], trusted["rc"]), ("2.15.1", ""))

    def test_what_the_body_says_about_the_release_is_not_believed(self):
        body = self._body(release="9.9.9", rc="rc99")
        body["payload"]["release"] = "9.9.9"
        handle(_cfg(), body, verified_repo="org/repo")

        _, trusted, _ = self.mocks["hud"].call_args[0]
        self.assertEqual((trusted["release"], trusted["rc"]), ("2.16.0", "rc9"))

    def test_it_takes_the_nightly_path_no_state_machine(self):
        handle(_cfg(), self._body(), verified_repo="org/repo")

        redis = self.mocks["redis"]
        redis.get_callback_state.assert_not_called()
        redis.set_callback_state.assert_not_called()
        redis.add_in_progress_tracker.assert_not_called()
        _, trusted, _ = self.mocks["hud"].call_args[0]
        self.assertIsNone(trusted["ci_metrics"]["queue_time"])

    def test_a_repo_that_has_not_opted_in_is_ignored_before_any_lookup(self):
        self.mock_map.get_repo_events.return_value = frozenset(
            {CrcrEvent.PULL_REQUEST, CrcrEvent.NIGHTLY}
        )
        result = handle(_cfg(), self._body(), verified_repo="org/repo")

        self.assertEqual(result, {"ok": True, "status": "ignored"})
        self.mocks["lookup"].assert_not_called()
        self.mocks["hud"].assert_not_called()

    def test_a_repo_not_in_the_allowlist_is_ignored(self):
        self.mock_map.get_repo_level.return_value = None
        result = handle(_cfg(), self._body(), verified_repo="unknown/repo")

        self.assertEqual(result, {"ok": True, "status": "ignored"})
        self.mocks["hud"].assert_not_called()

    def test_rate_limited(self):
        self.mocks["rate"].return_value = False
        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), self._body(), verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 429)

    def _rejected(self, body):
        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), body, verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 400)
        self.mocks["hud"].assert_not_called()
        return str(ctx.exception.detail)

    def test_a_name_that_is_not_a_release_tag_is_rejected_without_a_lookup(self):
        for tag in (
            None,
            "",
            9,
            "2.16.0-rc9",
            "v2.16-rc9",
            "v2.16.0rc9",
            "v2.16.0-rc9\n",
            "viable/strict/1",
            "v2.16.0-rc9/../v2.15.0",
        ):
            with self.subTest(tag=tag):
                self.assertIn(
                    "release_tag must be",
                    self._rejected(self._body(release_tag=tag)),
                )
        self.mocks["lookup"].assert_not_called()

    def test_a_report_without_a_tag_is_rejected(self):
        body = self._body()
        del body["release_tag"]
        self.assertIn("release_tag must be", self._rejected(body))

    def test_a_tag_the_upstream_repo_does_not_have_is_rejected(self):
        self.mocks["lookup"].return_value = None
        self.assertIn("has no tag v2.16.0-rc9", self._rejected(self._body()))

    def test_a_commit_that_is_not_the_tags_is_rejected(self):
        # e.g. the newest tag is rc10 but the installed wheel is still rc9
        self.mocks["lookup"].return_value = "b" * 40
        detail = self._rejected(self._body(release_tag="v2.16.0-rc10"))
        self.assertIn("v2.16.0-rc10 is commit " + "b" * 40, detail)

    def test_only_the_full_commit_sha_matches(self):
        for sha in (self.SHA[:12], self.SHA.upper(), "v2.16.0-rc9", 1):
            with self.subTest(sha=sha):
                self._rejected(self._body(delivery_id=sha))

    def test_a_tag_that_cannot_be_looked_up_is_a_retryable_503(self):
        self.mocks["lookup"].side_effect = RuntimeError("GitHub is down")
        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), self._body(), verified_repo="org/repo")

        self.assertEqual(ctx.exception.status_code, 503)
        self.assertIn("Retry-After", ctx.exception.headers)
        self.mocks["hud"].assert_not_called()

    def test_no_installation_token_is_a_retryable_503(self):
        self.mocks["token"].side_effect = RuntimeError("no installation")
        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), self._body(), verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 503)

    def test_only_a_completed_report_is_accepted_and_without_a_lookup(self):
        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), self._body(status="in_progress"), verified_repo="org/repo")

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("completed", str(ctx.exception.detail))
        self.mocks["lookup"].assert_not_called()

    def test_a_missing_delivery_id_is_a_400(self):
        body = self._body()
        del body["delivery_id"]
        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), body, verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_a_report_that_was_already_stored_is_a_duplicate(self):
        self.mocks["hud"].side_effect = HTTPException(409, "Record already finalized")
        result = handle(_cfg(), self._body(), verified_repo="org/repo")
        self.assertEqual(result, {"ok": True, "status": "duplicate"})

    def test_the_triage_verdict_is_validated_like_a_nightly(self):
        body = self._body()
        body["workflow"]["triage_verdict"] = {"category": "upstream"}
        handle(_cfg(), body, verified_repo="org/repo")

        _, _, untrusted = self.mocks["hud"].call_args[0]
        self.assertNotIn("triage_verdict", untrusted["callback_payload"]["workflow"])

    def test_a_nightly_report_has_no_release_and_needs_no_lookup(self):
        body = self._body()
        body["event_type"] = "nightly"
        handle(_cfg(), body, verified_repo="org/repo")

        self.mocks["lookup"].assert_not_called()
        _, trusted, _ = self.mocks["hud"].call_args[0]
        self.assertNotIn("release", trusted)
        self.assertNotIn("rc", trusted)


if __name__ == "__main__":
    unittest.main()
