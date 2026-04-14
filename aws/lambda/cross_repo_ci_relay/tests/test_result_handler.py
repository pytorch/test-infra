import time
import unittest
from unittest.mock import MagicMock, patch

from callback.result_handler import handle
from utils.misc import TimingPhase


def _cfg():
    cfg = MagicMock()
    cfg.hud_api_url = "http://hud/api/oot-ci-events"
    cfg.hud_bot_key = "bot-key-123"
    cfg.redis_endpoint = "host:6379"
    cfg.redis_login = ""
    cfg.oot_status_ttl = 259200
    return cfg


def _body(status="completed"):
    return {
        "event_type": "pull_request",
        "delivery_id": "del-123",
        "payload": {
            "pull_request": {"number": 42, "head": {"sha": "abc123"}},
            "repository": {"full_name": "pytorch/pytorch"},
        },
        "workflow": {
            "status": status,
            "conclusion": "success" if status == "completed" else None,
            "name": "CI",
            "url": "http://ci.example.com/run/1",
        },
    }


class TestResultHandler(unittest.TestCase):
    def setUp(self):
        self.patcher_allowlist = patch("callback.result_handler.load_allowlist")
        self.mock_load_allowlist = self.patcher_allowlist.start()
        mock_map = MagicMock()
        mock_map.get_repos_at_or_above_level.return_value = (["org/repo"], [])
        self.mock_load_allowlist.return_value = mock_map

        self.patcher_redis = patch("callback.result_handler.redis_helper")
        self.mock_redis = self.patcher_redis.start()
        self.mock_redis.create_client.return_value = MagicMock()
        self.mock_redis.get_timing.return_value = None

        self.patcher_hud = patch("callback.result_handler.forward_to_hud")
        self.mock_hud = self.patcher_hud.start()

    def tearDown(self):
        self.patcher_allowlist.stop()
        self.patcher_redis.stop()
        self.patcher_hud.stop()

    # --- allowlist uses the OIDC-verified repo, not the body ---

    def test_verified_repo_not_in_l2_returns_ignored(self):
        mock_map = MagicMock()
        mock_map.get_repos_at_or_above_level.return_value = (["other/repo"], [])
        self.mock_load_allowlist.return_value = mock_map

        result = handle(_cfg(), _body(), verified_repo="org/repo")

        self.assertEqual(result, {"ok": True, "status": "ignored"})
        self.assertFalse(self.mock_redis.create_client.called)
        self.assertFalse(self.mock_hud.called)

    # --- body is forwarded to HUD verbatim; authenticated_repo is a sibling ---

    def test_body_is_passed_to_hud_unchanged(self):
        body = _body()
        handle(_cfg(), body, verified_repo="org/repo")

        # forward_to_hud(config, downstream_report, ci_metrics, authenticated_repo)
        _, report_arg, metrics_arg, auth_repo_arg = self.mock_hud.call_args[0]
        self.assertIs(report_arg, body)
        self.assertEqual(auth_repo_arg, "org/repo")
        # authenticated_repo is a sibling of ci_metrics, not nested inside it.
        self.assertNotIn("authenticated_repo", metrics_arg)

    # --- timing ---

    def test_in_progress_records_timing_and_computes_queue_time(self):
        dispatch_at = time.time() - 30
        self.mock_redis.get_timing.return_value = dispatch_at

        result = handle(_cfg(), _body(status="in_progress"), verified_repo="org/repo")

        self.assertEqual(result, {"ok": True, "status": "in_progress"})
        # set_timing called with the verified repo, not any body-reported repo.
        args, _ = self.mock_redis.set_timing.call_args
        self.assertEqual(args[2], "org/repo")
        self.assertEqual(args[3], TimingPhase.IN_PROGRESS)
        _, _, metrics, _ = self.mock_hud.call_args[0]
        self.assertAlmostEqual(metrics["queue_time"], 30, delta=1.0)
        self.assertIsNone(metrics["execution_time"])

    def test_completed_computes_execution_time_only(self):
        # Each phase reports exactly one metric: completed → execution_time.
        # queue_time was already reported during in_progress, so HUD merges
        # the two rows on delivery_id.
        in_progress_at = time.time() - 30
        self.mock_redis.get_timing.return_value = in_progress_at

        result = handle(_cfg(), _body(status="completed"), verified_repo="org/repo")

        self.assertEqual(result, {"ok": True, "status": "completed"})
        _, _, metrics, _ = self.mock_hud.call_args[0]
        self.assertIsNone(metrics["queue_time"])
        self.assertAlmostEqual(metrics["execution_time"], 30, delta=1.0)

    # --- best-effort redis infra ---

    def test_get_timing_redis_error_does_not_break_handler(self):
        self.mock_redis.get_timing.return_value = None

        result = handle(_cfg(), _body(status="completed"), verified_repo="org/repo")

        self.assertEqual(result, {"ok": True, "status": "completed"})
        self.assertTrue(self.mock_hud.called)
        _, _, metrics, _ = self.mock_hud.call_args[0]
        self.assertIsNone(metrics["queue_time"])
        self.assertIsNone(metrics["execution_time"])

    def test_redis_client_unavailable_skips_timing(self):
        self.mock_redis.create_client.side_effect = RuntimeError("redis down")

        result = handle(_cfg(), _body(status="completed"), verified_repo="org/repo")

        self.assertEqual(result, {"ok": True, "status": "completed"})
        self.assertTrue(self.mock_hud.called)

    # --- HUD 4xx propagates (5xx is swallowed inside forward_to_hud) ---

    def test_hud_4xx_propagates(self):
        from utils.misc import HTTPException

        self.mock_hud.side_effect = HTTPException(422, "bad schema")

        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), _body(), verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 422)

    # --- required field validation ---

    def test_missing_delivery_id_returns_400(self):
        from utils.misc import HTTPException

        body = _body()
        del body["delivery_id"]

        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), body, verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_missing_workflow_status_returns_400(self):
        from utils.misc import HTTPException

        body = _body()
        del body["workflow"]["status"]

        with self.assertRaises(HTTPException) as ctx:
            handle(_cfg(), body, verified_repo="org/repo")
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
