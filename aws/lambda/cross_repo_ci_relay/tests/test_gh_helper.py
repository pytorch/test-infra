import unittest
from unittest.mock import MagicMock, PropertyMock

import github
from utils.gh_helper import get_tag_commit


def _object(sha, kind="commit"):
    target = MagicMock()
    target.sha = sha
    target.type = kind
    return target


class TestGetTagCommit(unittest.TestCase):
    def setUp(self):
        self.client = MagicMock()
        self.repo = self.client.get_repo.return_value

    def lookup(self):
        return get_tag_commit(
            token="t",
            repo_full_name="pytorch/pytorch",
            tag="v2.16.0-rc9",
            gh_client=self.client,
        )

    def test_a_lightweight_tag_points_at_its_commit(self):
        self.repo.get_git_ref.return_value.object = _object("a" * 40)

        self.assertEqual(self.lookup(), "a" * 40)
        self.repo.get_git_ref.assert_called_once_with("tags/v2.16.0-rc9")
        self.repo.get_git_tag.assert_not_called()

    def test_an_annotated_tag_is_followed_to_its_commit(self):
        self.repo.get_git_ref.return_value.object = _object("1" * 40, kind="tag")
        self.repo.get_git_tag.return_value.object = _object("a" * 40)

        self.assertEqual(self.lookup(), "a" * 40)
        self.repo.get_git_tag.assert_called_once_with("1" * 40)

    def test_no_such_tag(self):
        # PyGithub fetches the ref lazily: the 404 comes from reading its object.
        ref = MagicMock()
        type(ref).object = PropertyMock(
            side_effect=github.UnknownObjectException(404, {}, {})
        )
        self.repo.get_git_ref.return_value = ref

        self.assertIsNone(self.lookup())

    def test_other_github_errors_are_not_a_missing_tag(self):
        self.repo.get_git_ref.side_effect = github.GithubException(502, {}, {})

        with self.assertRaises(github.GithubException):
            self.lookup()


if __name__ == "__main__":
    unittest.main()
