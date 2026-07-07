"""Tests for zombie-job cleanup handler."""

import time
import unittest
from unittest.mock import MagicMock, patch

from callback.cleanup_handler import _build_timeout_payload, handle
from utils.allowlist import AllowlistLevel
from utils.misc import CallbackState
from utils.redis_helper import CallbackStateRecord


def _cfg():
    cfg = MagicMock()
    cfg.hud_api_url = "http://hud/api/crcr/results"
    cfg.hud_bot_key = "bot-key-123"
    cfg.zombie_timeout_seconds = 86400
    cfg.max_cleanup_workers = 4
    return cfg


def _callback_body(
    delivery_id="del-123",
    run_id=99999,
    run_attempt=1,
    status="in_progress",
    conclusion=None,
):
    """Build a minimal callback body matching the downstream composite action."""
    return {
        "event_type": "pull_request",
        "delivery_id": delivery_id,
        "payload": {
            "pull_request": {"number": 42, "head": {"sha": "abc123"}},
            "repository": {"full_name": "pytorch/pytorch"},
        },
        "workflow": {
            "schema_version": "1",
            "status": status,
            "conclusion": conclusion,
            "name": "CI",
            "url": "https://github.com/org/repo/actions/runs/999",
            "run_id": str(run_id),
            "run_attempt": str(run_attempt),
            "job_name": "my-job",
            "check_run_id": "cr-456",
            "started_at": "2026-06-17T10:00:00Z",
            "completed_at": None,
        },
    }


def _zombie_entry(
    delivery_id="del-123",
    repo="org/repo",
    run_id=99999,
    run_attempt=1,
    job_name="my-job",
    in_progress_ts=None,
    body_overrides=None,
):
    """Build a zombie dict as returned by scan_expired_in_progress."""
    if in_progress_ts is None:
        in_progress_ts = time.time() - 90000  # expired: ~25h ago

    body = _callback_body(delivery_id, run_id, run_attempt)
    if body_overrides:
        _deep_update(body, body_overrides)

    stored_payload = {
        "trusted": {
            "ci_metrics": {"queue_time": None, "execution_time": None},
            "verified_repo": repo,
            "downstream_repo_level": "L2",
        },
        "untrusted": {"callback_payload": body},
    }

    return {
        "delivery_id": delivery_id,
        "downstream_repo": repo,
        "run_id": run_id,
        "run_attempt": run_attempt,
        "job_name": job_name,
        "state_record": CallbackStateRecord(
            CallbackState.IN_PROGRESS, in_progress_ts, stored_payload
        ),
    }


def _deep_update(d, u):
    """Recursively update dict d with dict u."""
    for k, v in u.items():
        if isinstance(v, dict) and isinstance(d.get(k), dict):
            _deep_update(d[k], v)
        else:
            d[k] = v


class TestBuildTimeoutPayload(unittest.TestCase):
    def test_happy_path(self):
        """Payload includes all required fields for HUD."""
        now = time.time()
        zombie = _zombie_entry(in_progress_ts=now - 3600)  # 1h ago
        trusted, untrusted = _build_timeout_payload(zombie, "2026-06-18T11:00:00Z")

        # trusted
        self.assertEqual(trusted["verified_repo"], "org/repo")
        self.assertEqual(trusted["downstream_repo_level"], "L2")
        self.assertIsNone(trusted["ci_metrics"]["queue_time"])
        self.assertGreaterEqual(trusted["ci_metrics"]["execution_time"], 3600)

        # untrusted
        cp = untrusted["callback_payload"]
        self.assertEqual(cp["delivery_id"], "del-123")
        self.assertEqual(cp["event_type"], "pull_request")
        self.assertEqual(cp["payload"]["pull_request"]["number"], 42)
        self.assertEqual(cp["payload"]["repository"]["full_name"], "pytorch/pytorch")

        wf = cp["workflow"]
        self.assertEqual(wf["status"], "completed")
        self.assertEqual(wf["conclusion"], "timed_out")
        self.assertEqual(wf["name"], "CI")
        self.assertEqual(wf["job_name"], "my-job")
        self.assertEqual(wf["check_run_id"], "cr-456")
        self.assertEqual(wf["run_id"], "99999")
        self.assertEqual(wf["run_attempt"], "1")
        self.assertEqual(wf["completed_at"], "2026-06-18T11:00:00Z")

    def test_minimal_body(self):
        """Payload handles push events (no PR) correctly."""
        zombie = _zombie_entry(
            body_overrides={
                "event_type": "push",
                "payload": {
                    "pull_request": None,
                    "repository": {"full_name": "pytorch/pytorch"},
                },
            }
        )
        trusted, untrusted = _build_timeout_payload(zombie, "2026-06-18T11:00:00Z")

        cp = untrusted["callback_payload"]
        self.assertEqual(cp["event_type"], "push")
        self.assertIsNotNone(trusted["ci_metrics"]["execution_time"])

    def test_negative_execution_time_clamped_to_zero(self):
        """If in_progress timestamp is somehow in the future, execution_time is 0."""
        future_ts = time.time() + 3600
        zombie = _zombie_entry(in_progress_ts=future_ts)
        trusted, _ = _build_timeout_payload(zombie, "2026-06-18T11:00:00Z")
        self.assertEqual(trusted["ci_metrics"]["execution_time"], 0)


class TestCleanupHandler(unittest.TestCase):
    def setUp(self):
        self.patcher_redis = patch("callback.cleanup_handler.redis_helper")
        self.mock_redis = self.patcher_redis.start()

        self.patcher_hud = patch("callback.cleanup_handler.forward_to_hud")
        self.mock_hud = self.patcher_hud.start()

        self.patcher_load = patch("callback.cleanup_handler.load_allowlist")
        self.patcher_load.start()

    def tearDown(self):
        self.patcher_redis.stop()
        self.patcher_hud.stop()
        self.patcher_load.stop()

    def test_no_expired_jobs(self):
        """Empty scan returns cleanly."""
        self.mock_redis.scan_expired_in_progress.return_value = []
        result = handle(_cfg())
        self.assertEqual(result, {"ok": True, "cleaned": 0, "errors": 0})
        self.mock_hud.assert_not_called()

    def test_cleans_single_zombie(self):
        """Happy path: one expired zombie gets HUD forward + Redis cleanup."""
        zombie = _zombie_entry()
        self.mock_redis.scan_expired_in_progress.return_value = [zombie]

        result = handle(_cfg())

        self.assertEqual(result["cleaned"], 1)
        self.assertEqual(result["errors"], 0)

        # HUD was called
        self.mock_hud.assert_called_once()
        trusted, untrusted = self.mock_hud.call_args[0][1:]
        self.assertEqual(trusted["verified_repo"], "org/repo")
        self.assertEqual(
            untrusted["callback_payload"]["workflow"]["conclusion"], "timed_out"
        )

        # Redis state was updated to COMPLETED with job_name
        self.mock_redis.set_callback_state.assert_called_once()
        call_args = self.mock_redis.set_callback_state.call_args[0]
        self.assertEqual(call_args[1], "del-123")
        self.assertEqual(call_args[2], "org/repo")
        self.assertEqual(call_args[3], 99999)
        self.assertEqual(call_args[4], 1)
        self.assertEqual(call_args[5], CallbackState.COMPLETED)
        call_kwargs = self.mock_redis.set_callback_state.call_args[1]
        self.assertEqual(call_kwargs.get("job_name"), "my-job")

        # ZSET entry was removed with job_name
        self.mock_redis.remove_in_progress_tracker.assert_called_once()
        rm_kwargs = self.mock_redis.remove_in_progress_tracker.call_args[1]
        self.assertEqual(rm_kwargs.get("job_name"), "my-job")

    def test_cleans_multiple_zombies(self):
        """Multiple zombies are all cleaned independently."""
        zombies = [
            _zombie_entry(delivery_id="del-1", run_id=1),
            _zombie_entry(delivery_id="del-2", run_id=2),
            _zombie_entry(delivery_id="del-3", run_id=3),
        ]
        self.mock_redis.scan_expired_in_progress.return_value = zombies

        result = handle(_cfg())

        self.assertEqual(result["cleaned"], 3)
        self.assertEqual(result["errors"], 0)
        self.assertEqual(self.mock_hud.call_count, 3)
        self.assertEqual(self.mock_redis.set_callback_state.call_count, 3)
        self.assertEqual(self.mock_redis.remove_in_progress_tracker.call_count, 3)

    def test_hud_failure_records_error_continues(self):
        """If HUD forward fails for one zombie, it's counted as error and others continue."""
        zombie1 = _zombie_entry(delivery_id="del-1", run_id=1)
        zombie2 = _zombie_entry(delivery_id="del-2", run_id=2)

        self.mock_redis.scan_expired_in_progress.return_value = [zombie1, zombie2]

        def _hud_side_effect(_config, _trusted, untrusted):
            if untrusted["callback_payload"]["delivery_id"] == "del-1":
                raise Exception("HUD unreachable")
            # else succeeds

        self.mock_hud.side_effect = _hud_side_effect

        result = handle(_cfg())

        self.assertEqual(result["cleaned"], 1)
        self.assertEqual(result["errors"], 1)
        # Both zombies were attempted
        self.assertEqual(self.mock_hud.call_count, 2)

    def test_state_transition_assertion_error_continues(self):
        """If set_callback_state raises AssertionError (race condition), cleanup continues."""
        zombie = _zombie_entry()
        self.mock_redis.scan_expired_in_progress.return_value = [zombie]
        self.mock_redis.set_callback_state.side_effect = AssertionError(
            "rejecting duplicate COMPLETED"
        )

        result = handle(_cfg())

        # Still considered "cleaned" — HUD was forwarded and ZSET removed
        self.assertEqual(result["cleaned"], 1)
        self.assertEqual(result["errors"], 0)
        self.mock_hud.assert_called_once()
        self.mock_redis.remove_in_progress_tracker.assert_called_once()


class TestCleanupCheckRunFinalize(unittest.TestCase):
    """L3+ zombies also get a completed/timed_out upstream check run."""

    def setUp(self):
        self.patcher_redis = patch("callback.cleanup_handler.redis_helper")
        self.mock_redis = self.patcher_redis.start()
        self.patcher_hud = patch("callback.cleanup_handler.forward_to_hud")
        self.patcher_hud.start()

        self.patcher_load = patch("callback.cleanup_handler.load_allowlist")
        self.mock_load = self.patcher_load.start()
        self.mock_map = MagicMock()
        self.mock_map.get_repo_level.return_value = AllowlistLevel.L4
        self.mock_map.needs_check_run.return_value = True
        self.mock_load.return_value = self.mock_map

        self.patcher_gh = patch("callback.cleanup_handler.gh_helper")
        self.mock_gh = self.patcher_gh.start()
        self.mock_gh.get_repo_access_token.return_value = "tok"
        self.mock_gh.create_check_run.return_value = 777

    def tearDown(self):
        self.patcher_redis.stop()
        self.patcher_hud.stop()
        self.patcher_load.stop()
        self.patcher_gh.stop()

    def _level_zombie(self, level):
        zombie = _zombie_entry()
        zombie["state_record"].payload["trusted"]["downstream_repo_level"] = level
        return zombie

    def test_l4_zombie_finalizes_check_run_timed_out(self):
        self.mock_redis.scan_expired_in_progress.return_value = [
            self._level_zombie("L4")
        ]

        handle(_cfg())

        self.mock_gh.create_check_run.assert_called_once()
        kw = self.mock_gh.create_check_run.call_args[1]
        self.assertEqual(kw["status"], "completed")
        self.assertEqual(kw["conclusion"], "timed_out")
        self.assertEqual(kw["head_sha"], "abc123")

    def test_l2_zombie_does_not_finalize_check_run(self):
        # Default zombie is L2 → the stored-level pre-check short-circuits, no
        # upstream check run and no per-repo allowlist lookup.
        self.mock_redis.scan_expired_in_progress.return_value = [_zombie_entry()]

        handle(_cfg())

        self.mock_gh.create_check_run.assert_not_called()
        # Allowlist is loaded once for the whole sweep, then the L2 pre-check
        # skips the per-repo get_repo_level lookup.
        self.mock_load.assert_called_once()
        self.mock_map.get_repo_level.assert_not_called()


if __name__ == "__main__":
    unittest.main()
