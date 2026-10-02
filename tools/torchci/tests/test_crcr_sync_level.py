from unittest import main, mock, TestCase

from torchci.crcr_sync_level import (
    Action,
    AllowlistEditError,
    demote_in_allowlist,
    DemotionPR,
    plan,
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
        "noData": False,
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


class TestSync(TestCase):
    def run_sync(self, statuses, open_prs=None):
        upstream = mock.MagicMock()
        upstream.get_branch.return_value.commit.sha = "base"
        upstream.get_contents.return_value = mock.MagicMock(
            decoded_content=ALLOWLIST.encode(), sha="blob"
        )
        with (
            mock.patch(
                "torchci.crcr_sync_level.open_demotion_prs", return_value=open_prs or {}
            ),
            mock.patch("torchci.crcr_sync_level.open_pr") as open_pr,
            mock.patch("torchci.crcr_sync_level.close_pr") as close_pr,
        ):
            ok = sync(upstream, "pytorchbot", statuses)
        return ok, upstream, open_pr, close_pr

    def test_opens_a_pr_for_a_failing_repo(self):
        ok, upstream, open_pr, close_pr = self.run_sync(
            {"Ascend/pytorch": status("demote")}
        )
        self.assertTrue(ok)
        open_pr.assert_called_once()
        up, repo, text, blob_sha, base_sha, body = open_pr.call_args.args
        self.assertIs(up, upstream)
        self.assertEqual(repo, "Ascend/pytorch")
        self.assertEqual(text, demote_in_allowlist(ALLOWLIST, "Ascend/pytorch"))
        self.assertEqual((blob_sha, base_sha), ("blob", "base"))
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
        # Built again from main's allowlist; open_pr resets the branch and
        # reuses the open PR.
        open_pr.assert_called_once()
        up, repo, text, blob_sha, base_sha, _ = open_pr.call_args.args
        self.assertEqual(repo, "Ascend/pytorch")
        self.assertEqual(text, demote_in_allowlist(ALLOWLIST, "Ascend/pytorch"))
        self.assertEqual((blob_sha, base_sha), ("blob", "base"))
        close_pr.assert_not_called()


if __name__ == "__main__":
    main()
