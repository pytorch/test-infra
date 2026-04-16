import unittest
from unittest.mock import MagicMock

import redis as redis_lib
from utils import redis_helper
from utils.misc import TimingPhase
from utils.redis_helper import (
    _ALLOWLIST_CACHE_KEY,
    create_client,
    get_cached_yaml,
    set_cached_yaml,
)


def _cfg():
    cfg = MagicMock()
    cfg.redis_endpoint = "host:6379"
    cfg.redis_login = ""
    cfg.allowlist_ttl_seconds = 600
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


class TestTimingHelpers(unittest.TestCase):
    def setUp(self):
        redis_helper._cached_client = None
        redis_helper._cached_client_url = None

    def test_set_timing_swallows_redis_error(self):
        from utils.redis_helper import set_timing

        client = MagicMock()
        client.setex.side_effect = redis_lib.exceptions.RedisError("boom")
        cfg = MagicMock()
        cfg.redis_endpoint = "host:6379"
        cfg.redis_login = ""
        cfg.oot_status_ttl = 3600

        # must not raise — signature is (config, delivery_id, downstream_repo, phase, ts, client)
        set_timing(cfg, "del-123", "org/repo", TimingPhase.DISPATCH, 1234.5, client)

    def test_get_timing_returns_none_on_cache_miss(self):
        from utils.redis_helper import get_timing

        client = MagicMock()
        client.get.return_value = None
        cfg = MagicMock()
        cfg.redis_endpoint = "host:6379"
        cfg.redis_login = ""

        result = get_timing(cfg, "del-123", "org/repo", TimingPhase.DISPATCH, client)

        self.assertIsNone(result)

    def test_get_timing_swallows_redis_error(self):
        # Timing is a best-effort reporting enrichment — a Redis outage must
        # degrade gracefully to None rather than breaking the result handler.
        from utils.redis_helper import get_timing

        client = MagicMock()
        client.get.side_effect = redis_lib.exceptions.RedisError("timeout")
        cfg = MagicMock()
        cfg.redis_endpoint = "host:6379"
        cfg.redis_login = ""

        self.assertIsNone(
            get_timing(cfg, "del-123", "org/repo", TimingPhase.DISPATCH, client)
        )


if __name__ == "__main__":
    unittest.main()
