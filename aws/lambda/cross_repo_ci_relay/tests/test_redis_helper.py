import unittest
from unittest.mock import MagicMock

import redis as redis_lib

from redis_helper import _ALLOWLIST_CACHE_KEY, get_cached_yaml, set_cached_yaml


def _cfg():
    cfg = MagicMock()
    cfg.redis_endpoint = "host:6379"
    cfg.redis_login = ""
    cfg.allowlist_ttl_seconds = 600
    return cfg


class TestCachedYaml(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
