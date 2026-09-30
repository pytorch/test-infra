import unittest
from unittest.mock import MagicMock, patch

from utils import demotion
from utils.allowlist import AllowlistLevel


def _cfg():
    cfg = MagicMock()
    cfg.upstream_repo = "pytorch/pytorch"
    return cfg


@patch("utils.demotion.redis_helper")
class TestSuppressed(unittest.TestCase):
    def test_l3_is_held_back_only_while_it_is_demoted(self, redis):
        redis.get_demotion_since.return_value = None
        self.assertFalse(demotion.suppressed(_cfg(), AllowlistLevel.L3, "org/repo"))

        redis.get_demotion_since.return_value = 1000.0
        self.assertTrue(demotion.suppressed(_cfg(), AllowlistLevel.L3, "org/repo"))

    def test_a_job_that_started_before_the_demotion_is_not_held_back(self, redis):
        redis.get_demotion_since.return_value = 1000.0
        for started_at, expected in ((500.0, False), (1500.0, True)):
            with self.subTest(started_at=started_at):
                self.assertEqual(
                    demotion.suppressed(
                        _cfg(), AllowlistLevel.L3, "org/repo", started_at
                    ),
                    expected,
                )

    def test_other_levels_are_never_held_back(self, redis):
        redis.get_demotion_since.return_value = 1000.0
        for level in (AllowlistLevel.L4, AllowlistLevel.L2, None):
            with self.subTest(level=level):
                self.assertFalse(demotion.suppressed(_cfg(), level, "org/repo"))


@patch("utils.demotion.gh_helper")
@patch("utils.demotion.redis_helper")
@patch("utils.demotion.load_allowlist")
class TestReconcile(unittest.TestCase):
    def test_records_the_l3_repos_that_have_a_demotion_pr(self, load, redis, gh):
        cfg = _cfg()
        load.return_value.get_level.return_value = (
            ["org/open", "org/closed", "org/unreachable"],
            [],
        )

        def has_open_pull(*, token, repo_full_name, head):
            self.assertEqual(repo_full_name, "pytorch/pytorch")
            if head == "pytorch:crcr-demotion/org/open":
                return True
            if head == "pytorch:crcr-demotion/org/closed":
                return False
            raise RuntimeError("github is down")

        gh.has_open_pull.side_effect = has_open_pull

        demotion.reconcile(cfg)

        redis.set_demotion.assert_called_once_with(cfg, "org/open")
        redis.clear_demotion.assert_called_once_with(cfg, "org/closed")
        # org/unreachable could not be checked, so it is left as it was.


if __name__ == "__main__":
    unittest.main()
