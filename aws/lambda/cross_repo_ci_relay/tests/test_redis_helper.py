import json
import unittest
import unittest.mock
from unittest.mock import MagicMock

import redis as redis_lib
from utils import redis_helper
from utils.misc import CallbackState, DISPATCH_RUN_ATTEMPT, DISPATCH_RUN_ID
from utils.redis_helper import (
    _ALLOWLIST_CACHE_KEY,
    CallbackStateRecord,
    create_client,
    get_cached_yaml,
    get_callback_state,
    set_cached_yaml,
    set_callback_state,
)


def _cfg():
    cfg = MagicMock()
    cfg.redis_endpoint = "host:6379"
    cfg.redis_login = ""
    cfg.allowlist_ttl_seconds = 600
    cfg.oot_status_ttl = 3600
    cfg.rate_limit_per_min = 20
    return cfg


class TestCachedYaml(unittest.TestCase):
    def setUp(self):
        redis_helper._cached_client = None
        redis_helper._cached_client_url = None

    def test_cache_hit(self):
        client = MagicMock()
        client.get.return_value = "L1:\n  - org/repo\n"
        self.assertEqual(get_cached_yaml(_cfg(), client=client), "L1:\n  - org/repo\n")
        client.get.assert_called_once_with(_ALLOWLIST_CACHE_KEY)

    def test_redis_error_returns_none(self):
        client = MagicMock()
        client.get.side_effect = redis_lib.exceptions.RedisError("boom")
        self.assertIsNone(get_cached_yaml(_cfg(), client=client))

    def test_set_writes_with_ttl(self):
        client = MagicMock()
        set_cached_yaml(_cfg(), "yaml", client=client)
        client.setex.assert_called_once_with(_ALLOWLIST_CACHE_KEY, 600, "yaml")

    def test_create_client_reuses_cached_client_for_same_url(self):
        original_from_url = redis_helper.redis_lib.from_url
        client = MagicMock()
        mock_from_url = MagicMock(return_value=client)
        redis_helper.redis_lib.from_url = mock_from_url
        try:
            first = create_client(_cfg())
            second = create_client(_cfg())
        finally:
            redis_helper.redis_lib.from_url = original_from_url

        self.assertIs(first, client)
        self.assertIs(second, client)
        mock_from_url.assert_called_once()


class TestCallbackStateMachine(unittest.TestCase):
    def setUp(self):
        redis_helper._cached_client = None
        redis_helper._cached_client_url = None

    def test_set_dispatch_state_with_timestamp(self):
        """Webhook sets DISPATCHED state."""
        client = MagicMock()
        set_callback_state(
            _cfg(),
            "del-123",
            "org/repo",
            DISPATCH_RUN_ID,
            DISPATCH_RUN_ATTEMPT,
            CallbackState.DISPATCHED,
            1000.0,
            client=client,
        )
        client.setex.assert_called_once()

    def test_get_callback_state_parses_json(self):
        """get_callback_state returns CallbackStateRecord from JSON."""
        client = MagicMock()
        client.get.return_value = json.dumps(
            {
                "state": "IN_PROGRESS",
                "timestamp": 1010.5,
            }
        )
        cfg = _cfg()

        record = get_callback_state(cfg, "del-123", "org/repo", 12345, 1, client)

        self.assertIsNotNone(record)
        self.assertEqual(record.state, CallbackState.IN_PROGRESS)
        self.assertEqual(record.timestamp, 1010.5)

    def test_get_callback_state_returns_none_on_missing_key_and_on_redis_error(self):
        """get_callback_state returns None on missing key and on Redis error."""
        client = MagicMock()
        cfg = _cfg()

        client.get.return_value = None
        self.assertIsNone(
            get_callback_state(cfg, "del-123", "org/repo", 12345, 1, client)
        )

        client.get.side_effect = redis_lib.exceptions.RedisError("boom")
        self.assertIsNone(
            get_callback_state(cfg, "del-123", "org/repo", 12345, 1, client)
        )

    def test_invalid_state_transitions_rejected(self):
        """Duplicate or invalid state transitions are all rejected."""
        cases = [
            # (run_id, run_attempt, new_state, existing_state_value_or_None)
            (
                DISPATCH_RUN_ID,
                DISPATCH_RUN_ATTEMPT,
                CallbackState.DISPATCHED,
                "DISPATCHED",
            ),
            (12345, 1, CallbackState.IN_PROGRESS, "IN_PROGRESS"),
            (12345, 1, CallbackState.COMPLETED, None),  # None → COMPLETED
            (12345, 1, CallbackState.COMPLETED, "COMPLETED"),
        ]
        for run_id, run_attempt, state, existing in cases:
            with self.subTest(state=state, existing=existing):
                client = MagicMock()
                client.get.return_value = (
                    json.dumps(
                        {
                            "state": existing,
                            "timestamp": 1000.0,
                        }
                    )
                    if existing
                    else None
                )
                with self.assertRaises(AssertionError):
                    set_callback_state(
                        _cfg(),
                        "del-123",
                        "org/repo",
                        run_id,
                        run_attempt,
                        state,
                        1100.0,
                        client=client,
                    )
                client.setex.assert_not_called()

    def test_set_completed_from_in_progress_accepts(self):
        """IN_PROGRESS → COMPLETED transition is accepted."""
        client = MagicMock()
        client.get.return_value = json.dumps(
            {
                "state": "IN_PROGRESS",
                "timestamp": 1010.0,
            }
        )
        set_callback_state(
            _cfg(),
            "del-123",
            "org/repo",
            12345,
            1,
            CallbackState.COMPLETED,
            1020.0,
            workflow_name="test-workflow",
            client=client,
        )

    def test_set_in_progress_accepts_first_callback(self):
        """None → IN_PROGRESS is accepted when dispatch record exists."""

        def get_side_effect(
            cfg, delivery_id, repo, run_id_arg, run_attempt_arg, client=None
        ):
            if run_id_arg == DISPATCH_RUN_ID:
                return CallbackStateRecord(CallbackState.DISPATCHED, 1000.0, {})
            return None

        client = MagicMock()
        with unittest.mock.patch(
            "utils.redis_helper.get_callback_state", side_effect=get_side_effect
        ):
            set_callback_state(
                _cfg(),
                "del-123",
                "org/repo",
                99999,
                1,
                CallbackState.IN_PROGRESS,
                1010.0,
                workflow_name="test-workflow",
                client=client,
            )

    def test_set_non_dispatched_state_with_reserved_run_id_rejected(self):
        """Using the reserved DISPATCH_RUN_ID for non-DISPATCHED state is rejected."""
        client = MagicMock()
        cfg = _cfg()

        for state in (CallbackState.IN_PROGRESS, CallbackState.COMPLETED):
            with self.subTest(state=state):
                client.reset_mock()
                with self.assertRaises(AssertionError):
                    set_callback_state(
                        cfg,
                        "del-123",
                        "org/repo",
                        DISPATCH_RUN_ID,
                        DISPATCH_RUN_ATTEMPT,
                        state,
                        1010.0,
                        client=client,
                    )
                client.setex.assert_not_called()

    def test_set_callback_state_redis_exception_raises(self):
        """Redis write failure is re-raised as RedisError."""

        def get_side_effect(
            cfg, delivery_id, repo, run_id_arg, run_attempt_arg, client=None
        ):
            if run_id_arg == DISPATCH_RUN_ID:
                return CallbackStateRecord(CallbackState.DISPATCHED, 1000.0, {})
            return None

        cfg = _cfg()
        client = MagicMock()
        client.setex.side_effect = redis_lib.exceptions.RedisError("write failed")

        with unittest.mock.patch(
            "utils.redis_helper.get_callback_state", side_effect=get_side_effect
        ), self.assertRaises(redis_lib.exceptions.RedisError):
            set_callback_state(
                cfg,
                "del-123",
                "org/repo",
                99999,
                1,
                CallbackState.IN_PROGRESS,
                1010.0,
                workflow_name="test-workflow",
                client=client,
                payload={},
            )


class TestRateLimit(unittest.TestCase):
    def setUp(self):
        redis_helper._cached_client = None
        redis_helper._cached_client_url = None

    def test_check_rate_limit_allowed(self):
        from utils.redis_helper import check_rate_limit

        client = MagicMock()
        client.zcard.return_value = 10
        self.assertTrue(check_rate_limit(_cfg(), "org/repo", client=client))

    def test_check_rate_limit_exceeded(self):
        from utils.redis_helper import check_rate_limit

        client = MagicMock()
        client.zcard.return_value = 25
        self.assertFalse(check_rate_limit(_cfg(), "org/repo", client=client))

    def test_check_rate_limit_redis_error_raises_500(self):
        from utils.misc import HTTPException
        from utils.redis_helper import check_rate_limit

        client = MagicMock()
        client.zadd.side_effect = redis_lib.exceptions.RedisError("boom")
        with self.assertRaises(HTTPException) as ctx:
            check_rate_limit(_cfg(), "org/repo", client=client)
        self.assertEqual(ctx.exception.status_code, 500)


class TestInProgressTracker(unittest.TestCase):
    def setUp(self):
        redis_helper._cached_client = None
        redis_helper._cached_client_url = None

    def _cfg_with_zombie_timeout(self):
        cfg = _cfg()
        cfg.zombie_timeout_seconds = 86400
        cfg.in_progress_warn_threshold = 1000
        return cfg

    def test_add_in_progress_tracker_zadd_with_correct_score(self):
        """ZADD with now + zombie_timeout_seconds as score."""
        from utils.redis_helper import add_in_progress_tracker

        client = MagicMock()
        cfg = self._cfg_with_zombie_timeout()
        now = 1700000000.0

        with unittest.mock.patch("utils.redis_helper.time") as mock_time:
            mock_time.time.return_value = now
            add_in_progress_tracker(cfg, "del-123", "org/repo", 99999, 1, client=client)

        expected_member = "del-123:org/repo:99999:1"
        expected_score = now + 86400
        client.zadd.assert_called_once_with(
            "oot:in_progress", {expected_member: expected_score}
        )
        client.expire.assert_called_once_with("oot:in_progress", 172800)

    def test_add_in_progress_tracker_redis_error_is_silent(self):
        """Redis errors are logged but not raised — tracker is best-effort."""
        from utils.redis_helper import add_in_progress_tracker

        client = MagicMock()
        client.zadd.side_effect = redis_lib.exceptions.RedisError("boom")
        cfg = self._cfg_with_zombie_timeout()

        # Should not raise
        add_in_progress_tracker(cfg, "del-123", "org/repo", 99999, 1, client=client)

    def test_remove_in_progress_tracker_zrem(self):
        """ZREM removes the member from the ZSET."""
        from utils.redis_helper import remove_in_progress_tracker

        client = MagicMock()
        cfg = _cfg()
        remove_in_progress_tracker(cfg, "del-123", "org/repo", 99999, 1, client=client)

        client.zrem.assert_called_once_with(
            "oot:in_progress", "del-123:org/repo:99999:1"
        )

    def test_remove_in_progress_tracker_redis_error_is_silent(self):
        """Redis errors on removal are logged but not raised."""
        from utils.redis_helper import remove_in_progress_tracker

        client = MagicMock()
        client.zrem.side_effect = redis_lib.exceptions.RedisError("boom")
        cfg = _cfg()

        # Should not raise
        remove_in_progress_tracker(cfg, "del-123", "org/repo", 99999, 1, client=client)

    def test_scan_expired_returns_only_in_progress_zombies(self):
        """scan_expired_in_progress returns entries whose state is IN_PROGRESS."""
        from utils.redis_helper import scan_expired_in_progress

        cfg = self._cfg_with_zombie_timeout()
        client = MagicMock()
        client.zcard.return_value = 0
        now = 1700000000.0
        client.zrangebyscore.return_value = [
            "del-1:org/repo:10:1",
            "del-2:org/repo:20:1",
        ]

        # First entry is IN_PROGRESS (zombie), second is already COMPLETED
        get_returns = [
            json.dumps({"state": "IN_PROGRESS", "timestamp": now - 90000}),
            json.dumps({"state": "COMPLETED", "timestamp": now - 100}),
        ]

        def get_side_effect(key):
            return get_returns.pop(0) if get_returns else None

        client.get.side_effect = get_side_effect

        with unittest.mock.patch("utils.redis_helper.time") as mock_time:
            mock_time.time.return_value = now
            results = scan_expired_in_progress(cfg, client=client)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["delivery_id"], "del-1")
        self.assertEqual(results[0]["downstream_repo"], "org/repo")
        self.assertEqual(results[0]["run_id"], 10)
        self.assertEqual(results[0]["run_attempt"], 1)
        self.assertEqual(results[0]["state_record"].state, CallbackState.IN_PROGRESS)

        # Second entry (COMPLETED) had its tracker cleaned up
        client.zrem.assert_any_call("oot:in_progress", "del-2:org/repo:20:1")

    def test_scan_expired_skips_missing_state_records(self):
        """Members whose state record is gone are cleaned from the ZSET."""
        from utils.redis_helper import scan_expired_in_progress

        cfg = self._cfg_with_zombie_timeout()
        client = MagicMock()
        client.zcard.return_value = 0
        client.zrangebyscore.return_value = ["del-missing:org/repo:5:1"]
        client.get.return_value = None  # state record expired

        with unittest.mock.patch("utils.redis_helper.time") as mock_time:
            mock_time.time.return_value = 1700000000.0
            results = scan_expired_in_progress(cfg, client=client)

        self.assertEqual(results, [])
        client.zrem.assert_called_once_with(
            "oot:in_progress", "del-missing:org/repo:5:1"
        )

    def test_scan_expired_handles_malformed_member(self):
        """Malformed ZSET members are removed with a warning."""
        from utils.redis_helper import scan_expired_in_progress

        cfg = self._cfg_with_zombie_timeout()
        client = MagicMock()
        client.zcard.return_value = 0
        client.zrangebyscore.return_value = ["bad-member"]

        with unittest.mock.patch("utils.redis_helper.time") as mock_time:
            mock_time.time.return_value = 1700000000.0
            results = scan_expired_in_progress(cfg, client=client)

        self.assertEqual(results, [])
        client.zrem.assert_called_once_with("oot:in_progress", "bad-member")

    def test_set_callback_state_with_payload(self):
        """Payload is stored alongside state and timestamp under a "payload" key."""
        client = MagicMock()
        cfg = _cfg()
        payload = {
            "trusted": {
                "ci_metrics": {"queue_time": None, "execution_time": None},
                "verified_repo": "org/repo",
                "downstream_repo_level": "L2",
            },
            "untrusted": {
                "delivery_id": "del-123",
                "workflow": {"name": "CI", "run_id": "99999"},
            },
        }

        with unittest.mock.patch(
            "utils.redis_helper.get_callback_state", return_value=None
        ):
            set_callback_state(
                cfg,
                "del-123",
                "org/repo",
                99999,
                1,
                CallbackState.IN_PROGRESS,
                1010.0,
                workflow_name="test-workflow",
                client=client,
                payload=payload,
            )

        # setex(key, ttl, value): args[0] is key, args[1] is ttl, args[2] is JSON.
        call_args = client.setex.call_args
        stored_json = call_args[0][2]
        stored = json.loads(stored_json)
        self.assertEqual(stored["state"], "IN_PROGRESS")
        self.assertEqual(stored["timestamp"], 1010.0)
        self.assertEqual(stored["payload"]["trusted"]["verified_repo"], "org/repo")
        self.assertEqual(stored["payload"]["untrusted"]["workflow"]["name"], "CI")


if __name__ == "__main__":
    unittest.main()
