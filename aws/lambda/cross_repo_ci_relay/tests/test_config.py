import unittest
from unittest.mock import patch

from utils.config import RelayConfig, RelaySecrets


_ENV = {
    "GITHUB_APP_ID": "123",
    "GITHUB_APP_SECRET": "s",
    "GITHUB_APP_PRIVATE_KEY": "k",
    "ALLOWLIST_URL": "https://github.com/o/r/blob/main/f.yaml",
    "REDIS_ENDPOINT": "cache:6379",
    "REDIS_LOGIN": "local-pass",
}


class TestConfig(unittest.TestCase):
    @patch.dict("os.environ", _ENV, clear=True)
    def test_from_env_correct_path(self):
        cfg = RelayConfig.from_env()
        self.assertEqual(cfg.github_app_id, "123")
        self.assertEqual(cfg.upstream_repo, "pytorch/pytorch")
        self.assertEqual(cfg.redis_login, "local-pass")

    @patch.dict("os.environ", {}, clear=True)
    def test_missing_vars_raises(self):
        with self.assertRaises(RuntimeError):
            RelayConfig.from_env()

    @patch("utils.config.RelaySecrets.from_aws")
    @patch.dict(
        "os.environ",
        {
            **_ENV,
            "GITHUB_APP_SECRET": "",
            "GITHUB_APP_PRIVATE_KEY": "",
            "SECRET_STORE_ARN": "arn:secret",
        },
        clear=True,
    )
    def test_secrets_manager_fallback(self, mock_aws):
        mock_aws.return_value = RelaySecrets(
            github_app_secret="s",
            github_app_private_key="k",
            redis_login="secret-pass",
            hud_bot_key="hud-key",
        )
        cfg = RelayConfig.from_env()
        self.assertEqual(cfg.github_app_secret, "s")
        self.assertEqual(cfg.redis_login, "local-pass")
        mock_aws.assert_called_once()


if __name__ == "__main__":
    unittest.main()
