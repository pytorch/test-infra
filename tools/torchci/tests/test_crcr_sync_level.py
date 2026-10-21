from contextlib import ExitStack
from unittest import main, mock, TestCase

from github import GithubException
from torchci.crcr_sync_level import (
    Action,
    AllowlistEditError,
    demote_in_allowlist,
    DemotionPR,
    open_pr,
    plan,
    pr_body,
    REFRESH_COMMENT,
    sync,
)


ALLOWLIST = """\
L2:
  - a/one
  - b/two:
      events:
        - nightly

L3:
  crcr-test:
    pytorch/crcr-test: [alice]
  npu:
    Ascend/pytorch: [huangjingwei, kerer-ai]
"""


def status(change, **extra):
    return {
        "level": "L3",
        "change": change,
        "windowDays": 7,
        "criteria": [
            {
                "criterion": "Job Pass Rate",
                "measured": "85.0%",
                "target": "≥ 90%",
                "met": False,
            }
        ],
        **extra,
    }


class TestDemoteInAllowlist(TestCase):
    def test_moves_the_repo_to_l2_as_a_bare_name(self):
        self.assertEqual(
            demote_in_allowlist(ALLOWLIST, "Ascend/pytorch"),
            """\
L2:
  - a/one
  - b/two:
      events:
        - nightly
  - Ascend/pytorch

L3:
  crcr-test:
    pytorch/crcr-test: [alice]
""",
        )

    def test_keeps_the_device_group_when_other_repos_are_in_it(self):
        text = ALLOWLIST + "    Other/npu: [bob]\n"
        new_text = demote_in_allowlist(text, "Ascend/pytorch")
        self.assertIn("  npu:\n    Other/npu: [bob]\n", new_text)
        self.assertIn("  - Ascend/pytorch\n", new_text)

    def test_rejects_a_repo_that_is_not_at_l3(self):
        with self.assertRaises(AllowlistEditError):
            demote_in_allowlist(ALLOWLIST, "a/one")


class TestPlan(TestCase):
    def test_opens_and_closes(self):
        statuses = {
            "fails/new": status("demote"),
            "fails/has-pr": status("demote"),
            "fails/conflicted": status("demote"),
            "recovered/has-pr": status(None),
            "healthy/no-pr": status(None),
        }
        l3 = {repo: [] for repo in statuses}
        open_prs = {
            "fails/has-pr": DemotionPR(1, conflicted=False),
            "fails/conflicted": DemotionPR(3, conflicted=True),
            "recovered/has-pr": DemotionPR(2, conflicted=False),
        }
        self.assertEqual(
            plan(statuses, l3, open_prs),
            [
                Action("close", "recovered/has-pr", "is back within its L3 targets"),
                Action("refresh", "fails/conflicted"),
                Action("open", "fails/new"),
            ],
        )


class TestPrBody(TestCase):
    def test_every_mention_is_a_separate_word(self):
        """A mention glued to the next one (`@a@b`) notifies neither."""
        body = pr_body("Ascend/pytorch", status("demote"), ["huangjingwei", "zyw-hw"])
        self.assertIn("\ncc @huangjingwei @zyw-hw @atalman\n", body)

    def test_the_reviewer_is_mentioned_even_without_oncalls(self):
        body = pr_body("a/b", status("demote"), [])
        self.assertIn(
            "No oncalls are listed for this repo in the allowlist.\n\ncc @atalman\n",
            body,
        )


class TestSync(TestCase):
    def run_sync(self, statuses, open_prs=None):
        upstream = mock.MagicMock()
        upstream.get_branch.return_value.commit.sha = "base"
        upstream.get_contents.return_value = mock.MagicMock(
            decoded_content=ALLOWLIST.encode()
        )

        def patch(name, **kwargs):
            return stack.enter_context(
                mock.patch(f"torchci.crcr_sync_level.{name}", **kwargs)
            )

        with ExitStack() as stack:
            patch("open_demotion_prs", return_value=open_prs or {})
            open_pr = patch("open_pr")
            close_pr = patch("close_pr")
            ok = sync(upstream, "pytorchbot", statuses)
        return ok, upstream, open_pr, close_pr

    def test_opens_a_pr_for_a_failing_repo(self):
        ok, upstream, open_pr, close_pr = self.run_sync(
            {"Ascend/pytorch": status("demote")}
        )
        self.assertTrue(ok)
        open_pr.assert_called_once()
        up, repo, text, base_sha, body = open_pr.call_args.args
        self.assertIs(up, upstream)
        self.assertEqual(repo, "Ascend/pytorch")
        self.assertEqual(text, demote_in_allowlist(ALLOWLIST, "Ascend/pytorch"))
        self.assertEqual(base_sha, "base")
        self.assertIn("| Job Pass Rate | 85.0% | ≥ 90% |", body)
        self.assertIn("Over the last 7 days", body)
        # The oncalls are told, even though L2 does not keep them.
        self.assertIn("cc @huangjingwei @kerer-ai", body)
        close_pr.assert_not_called()

    def test_closes_the_pr_once_the_repo_recovers(self):
        ok, upstream, open_pr, close_pr = self.run_sync(
            {"Ascend/pytorch": status(None)},
            open_prs={"Ascend/pytorch": DemotionPR(5, conflicted=False)},
        )
        self.assertTrue(ok)
        close_pr.assert_called_once()
        self.assertEqual(close_pr.call_args.args[:3], (upstream, 5, "Ascend/pytorch"))
        open_pr.assert_not_called()

    def test_leaves_an_open_pr_alone_while_the_repo_still_fails(self):
        ok, _, open_pr, close_pr = self.run_sync(
            {"Ascend/pytorch": status("demote")},
            open_prs={"Ascend/pytorch": DemotionPR(5, conflicted=False)},
        )
        self.assertTrue(ok)
        open_pr.assert_not_called()
        close_pr.assert_not_called()

    def test_rebuilds_a_pr_that_conflicts_with_main(self):
        ok, upstream, open_pr, close_pr = self.run_sync(
            {"Ascend/pytorch": status("demote")},
            open_prs={"Ascend/pytorch": DemotionPR(5, conflicted=True)},
        )
        self.assertTrue(ok)
        # Built again from main's allowlist; open_pr moves the branch and
        # reuses the open PR.
        open_pr.assert_called_once()
        up, repo, text, base_sha, _ = open_pr.call_args.args
        self.assertEqual(repo, "Ascend/pytorch")
        self.assertEqual(text, demote_in_allowlist(ALLOWLIST, "Ascend/pytorch"))
        self.assertEqual(base_sha, "base")
        close_pr.assert_not_called()


class TestOpenPr(TestCase):
    def upstream(self):
        upstream = mock.MagicMock()
        upstream.create_git_blob.return_value.sha = "blob"
        upstream.create_git_commit.return_value.sha = "new"
        return upstream

    def test_a_new_pr_gets_a_new_branch_at_the_commit(self):
        upstream = self.upstream()

        pr = open_pr(upstream, "Ascend/pytorch", "text", "base", "body")

        upstream.create_git_ref.assert_called_once_with(
            "refs/heads/crcr-demotion/Ascend/pytorch", "new"
        )
        upstream.get_git_ref.assert_not_called()
        upstream.create_pull.assert_called_once()
        self.assertIs(pr, upstream.create_pull.return_value)
        pr.edit.assert_not_called()
        pr.create_issue_comment.assert_not_called()

    def test_refresh_moves_the_branch_straight_to_the_new_commit(self):
        upstream = self.upstream()
        upstream.create_git_ref.side_effect = GithubException(422)
        upstream.create_pull.side_effect = GithubException(422)
        existing = mock.MagicMock()
        upstream.get_pulls.return_value = [existing]

        pr = open_pr(upstream, "Ascend/pytorch", "text", "base", "body")

        # The commit is built on main, and the branch is forced onto it in one
        # step: never onto main itself, which would leave the PR empty and get
        # it closed by GitHub.
        upstream.get_git_commit.assert_called_once_with("base")
        upstream.create_git_blob.assert_called_once_with("text", "utf-8")
        parents = upstream.create_git_commit.call_args.args[2]
        self.assertEqual(parents, [upstream.get_git_commit.return_value])
        upstream.get_git_ref.assert_called_once_with(
            "heads/crcr-demotion/Ascend/pytorch"
        )
        upstream.get_git_ref.return_value.edit.assert_called_once_with(
            "new", force=True
        )
        upstream.update_file.assert_not_called()
        names = [c[0] for c in upstream.mock_calls]
        self.assertLess(
            names.index("create_git_commit"), names.index("get_git_ref().edit")
        )
        self.assertIs(pr, existing)

    def test_refresh_updates_the_body_and_says_the_branch_was_rebuilt(self):
        upstream = self.upstream()
        upstream.create_git_ref.side_effect = GithubException(422)
        upstream.create_pull.side_effect = GithubException(422)
        existing = mock.MagicMock()
        upstream.get_pulls.return_value = [existing]

        open_pr(upstream, "Ascend/pytorch", "text", "base", "new body")

        existing.edit.assert_called_once_with(body="new body")
        existing.create_issue_comment.assert_called_once_with(REFRESH_COMMENT)

    def test_a_failed_create_with_no_open_pr_is_raised(self):
        upstream = self.upstream()
        upstream.create_pull.side_effect = GithubException(422)
        upstream.get_pulls.return_value = []

        with self.assertRaises(GithubException):
            open_pr(upstream, "Ascend/pytorch", "text", "base", "body")


if __name__ == "__main__":
    main()
