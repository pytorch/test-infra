import sys
import unittest
from unittest.mock import MagicMock, patch


# Ensure package import when running from repo root
sys.path.insert(0, "aws/lambda/pytorch-auto-revert")

from pytorch_auto_revert import autorevert_circuit_breaker  # noqa: E402
from pytorch_auto_revert.autorevert_circuit_breaker import (  # noqa: E402
    check_autorevert_disabled,
    DISABLE_AUTOREVERT_LABEL,
)


def _event(event_type, label_name=None, actor_login=None):
    ev = MagicMock()
    ev.event = event_type
    if label_name is None:
        ev.label = None
    else:
        ev.label = MagicMock()
        ev.label.name = label_name
    if actor_login is None:
        ev.actor = None
    else:
        ev.actor = MagicMock()
        ev.actor.login = actor_login
    return ev


def _make_issue(number, events):
    """events: list of (event_type, label_name|None, actor_login|None)."""
    issue = MagicMock()
    issue.number = number
    issue.user = MagicMock()
    issue.user.login = "issue-author"
    issue.get_events.return_value = [_event(*e) for e in events]
    return issue


def _labeled_issue(number, applier_login):
    """An issue whose disable-autorevert label was applied by applier_login."""
    return _make_issue(number, [("labeled", DISABLE_AUTOREVERT_LABEL, applier_login)])


class TestCheckAutorevertDisabled(unittest.TestCase):
    def _run_with(self, issues, permission_map, perm_side_effect=None):
        """Run check_autorevert_disabled against a mocked GitHub repo.

        issues: list of mock issues returned by repo.get_issues
        permission_map: dict applier-login -> permission string
        perm_side_effect: optional callable(login) used instead of the map
        """
        repo = MagicMock()
        repo.get_issues.return_value = issues

        if perm_side_effect is not None:
            repo.get_collaborator_permission.side_effect = perm_side_effect
        else:
            repo.get_collaborator_permission.side_effect = lambda login: permission_map[
                login
            ]

        client = MagicMock()
        client.get_repo.return_value = repo

        factory = MagicMock()
        factory.client = client

        with patch.object(
            autorevert_circuit_breaker, "GHClientFactory", return_value=factory
        ):
            result = check_autorevert_disabled("pytorch/pytorch")
        return result, repo

    def test_no_issues_returns_false(self):
        result, repo = self._run_with([], {})
        self.assertFalse(result)
        repo.get_collaborator_permission.assert_not_called()

    def test_write_access_applier_disables(self):
        result, _ = self._run_with(
            [_labeled_issue(1, "maintainer")], {"maintainer": "write"}
        )
        self.assertTrue(result)

    def test_admin_and_maintain_appliers_disable(self):
        for perm in ("admin", "maintain"):
            with self.subTest(perm=perm):
                result, _ = self._run_with([_labeled_issue(1, "boss")], {"boss": perm})
                self.assertTrue(result)

    def test_unprivileged_applier_does_not_disable(self):
        # The exploit case: a NONE/read user trips the label via the template,
        # so the "labeled" event's actor is that unprivileged user.
        for perm in ("none", "read"):
            with self.subTest(perm=perm):
                result, _ = self._run_with(
                    [_labeled_issue(188383, "shameelvk9-png")],
                    {"shameelvk9-png": perm},
                )
                self.assertFalse(result)

    def test_triage_applier_does_not_disable(self):
        # Triagers can manage labels but must not be able to disable autorevert.
        result, _ = self._run_with(
            [_labeled_issue(1, "triager")], {"triager": "triage"}
        )
        self.assertFalse(result)

    def test_maintainer_labeling_unprivileged_authored_issue_disables(self):
        # Author is unprivileged; a maintainer applied the label. This must be
        # honored (the author-permission approach would wrongly ignore it).
        issue = _make_issue(1, [("labeled", DISABLE_AUTOREVERT_LABEL, "maintainer")])
        issue.user.login = "random-contributor"
        result, _ = self._run_with([issue], {"maintainer": "write"})
        self.assertTrue(result)

    def test_latest_applier_wins_after_relabel(self):
        # Removed then re-applied by an unprivileged user -> latest applier (none) governs.
        issue = _make_issue(
            1,
            [
                ("labeled", DISABLE_AUTOREVERT_LABEL, "maintainer"),
                ("unlabeled", DISABLE_AUTOREVERT_LABEL, "maintainer"),
                ("labeled", DISABLE_AUTOREVERT_LABEL, "rando"),
            ],
        )
        result, _ = self._run_with([issue], {"maintainer": "write", "rando": "none"})
        self.assertFalse(result)

    def test_no_labeled_event_is_ignored(self):
        # Label present but no "labeled" event for it (anomalous) -> fail safe.
        issue = _make_issue(
            1, [("closed", None, "someone"), ("assigned", None, "someone")]
        )
        result, repo = self._run_with([issue], {})
        self.assertFalse(result)
        repo.get_collaborator_permission.assert_not_called()

    def test_unprivileged_then_privileged_keeps_evaluating(self):
        result, _ = self._run_with(
            [_labeled_issue(1, "rando"), _labeled_issue(2, "maintainer")],
            {"rando": "none", "maintainer": "write"},
        )
        self.assertTrue(result)

    def test_get_events_error_is_skipped_fail_safe(self):
        issue = _labeled_issue(1, "maintainer")
        issue.get_events.side_effect = RuntimeError("github api hiccup")
        result, _ = self._run_with([issue], {"maintainer": "write"})
        self.assertFalse(result)

    def test_permission_lookup_error_is_skipped_fail_safe(self):
        def boom(login):
            raise RuntimeError("github api hiccup")

        result, _ = self._run_with(
            [_labeled_issue(1, "rando")], {}, perm_side_effect=boom
        )
        self.assertFalse(result)

    def test_permission_error_on_one_issue_does_not_block_authorized_one(self):
        def perm(login):
            if login == "rando":
                raise RuntimeError("github api hiccup")
            return "admin"

        result, _ = self._run_with(
            [_labeled_issue(1, "rando"), _labeled_issue(2, "maintainer")],
            {},
            perm_side_effect=perm,
        )
        self.assertTrue(result)


if __name__ == "__main__":
    unittest.main()
