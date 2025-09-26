import json
import os
import unittest
from datetime import datetime
from unittest.mock import patch, PropertyMock

from pytorch_auto_revert.autorevert_checker import (
    AutorevertPatternChecker,
    CommitJobs,
    JobResult,
)
from pytorch_auto_revert.event_logger import log_autorevert_event
from pytorch_auto_revert.workflow_checker import WorkflowRestartChecker


FIXTURES = os.path.join(os.path.dirname(__file__), "resources")


def _load_json(name):
    with open(os.path.join(FIXTURES, name), "r") as f:
        return json.load(f)


class FakeCHResult:
    def __init__(self, rows):
        self.result_rows = rows


class FakeCHClient:
    """Simple router over our pinned fixtures based on query shape."""

    def __init__(self):
        self.inserts = []
        self._workflow_main = _load_json("workflow_job_main.json")
        self._workflow_restarted = _load_json("workflow_job_restarted.json")
        self._push_commits = _load_json("push_commits.json")
        self._issue_comments = _load_json("issue_comments.json")

    def query(self, query: str, parameters=None):
        parameters = parameters or {}
        q = " ".join(query.split())
        # workflow jobs on main (non-restarted)
        if "FROM workflow_job" in q and "head_branch = 'main'" in q:
            rows = []
            for wf_name, sha, name, concl, status, rule, created in self._workflow_main:
                created_at = datetime.fromisoformat(created)
                rows.append((wf_name, sha, name, concl, status, rule, created_at))
            return FakeCHResult(rows)

        # Single-commit fetch (both main and restarted paths)
        if "FROM workflow_job" in q and "AND head_sha = {head_sha:String}" in q:
            head_sha = parameters.get("head_sha")
            restarted = "workflow_event = {we:String}" in q and "trunk/%" in q
            rows = []
            if restarted:
                items = self._workflow_restarted.get(head_sha, [])
                for name, concl, status, rule, created in items:
                    rows.append(
                        (
                            head_sha,
                            name,
                            concl,
                            status,
                            rule,
                            datetime.fromisoformat(created),
                        )
                    )
            else:
                for (
                    _wf_name,
                    sha,
                    name,
                    concl,
                    status,
                    rule,
                    created,
                ) in self._workflow_main:
                    if sha == head_sha:
                        rows.append(
                            (
                                sha,
                                name,
                                concl,
                                status,
                                rule,
                                datetime.fromisoformat(created),
                            )
                        )
            return FakeCHResult(rows)

        # push table commit history
        if "FROM default.push" in q:
            rows = []
            for sha, msg, ts in self._push_commits:
                rows.append((sha, msg, datetime.fromisoformat(ts)))
            return FakeCHResult(rows)

        # issue_comment for revert categories
        if "FROM issue_comment" in q:
            ids = set(parameters.get("comment_ids", []))
            rows = [tuple(i) for i in self._issue_comments if i[0] in ids]
            return FakeCHResult(rows)

        # Workflow restarted checker query (workflow_dispatch/head_branch trunk/<sha>)
        if "materialized_views.workflow_job_by_head_sha" in q and "workflow_event" in q:
            head_sha = parameters.get("commit_sha")
            if head_sha in self._workflow_restarted:
                return FakeCHResult([(1,)])
            return FakeCHResult([])

        return FakeCHResult([])

    def insert(self, *, table, data, column_names, database=None):
        self.inserts.append(
            {
                "table": table,
                "data": data,
                "columns": column_names,
                "database": database,
            }
        )


class FakeWorkflowRef:
    def __init__(self, display_name: str = "trunk", file_name: str = "trunk.yml"):
        self.display_name = display_name
        self.file_name = file_name


class FakeResolver:
    def __init__(self, ref: FakeWorkflowRef | None = None):
        self._ref = ref or FakeWorkflowRef()

    def require(self, name: str):
        return self._ref


class TestAutorevertMocked(unittest.TestCase):
    def setUp(self):
        self.fake_ch = FakeCHClient()

        ch_patch = patch(
            "pytorch_auto_revert.clickhouse_client_helper.CHCliFactory.client",
            new_callable=PropertyMock,
            return_value=self.fake_ch,
        )
        self.addCleanup(ch_patch.stop)
        ch_patch.start()

        # Ensure property path is exercised: patch the classmethod used inside the property
        resolver_get_patch = patch(
            "pytorch_auto_revert.workflow_checker.WorkflowResolver.get",
            return_value=FakeResolver(FakeWorkflowRef("trunk", "trunk.yml")),
        )
        self.addCleanup(resolver_get_patch.stop)
        resolver_get_patch.start()

        token_patch = patch(
            "pytorch_auto_revert.github_client_helper.GHClientFactory.token_auth_provided",
            new_callable=PropertyMock,
            return_value=True,
        )
        self.addCleanup(token_patch.stop)
        token_patch.start()

        class _FakeWf:
            def create_dispatch(self, ref, inputs=None):
                return True

        class _FakeRepo:
            def get_workflow(self, fname):
                return _FakeWf()

        class _FakeGH:
            def get_repo(self, full):
                return _FakeRepo()

        gh_patch = patch(
            "pytorch_auto_revert.github_client_helper.GHClientFactory.client",
            new_callable=PropertyMock,
            return_value=_FakeGH(),
        )
        self.addCleanup(gh_patch.stop)
        gh_patch.start()

    # ------------------------
    # Synthetic pattern tests
    # ------------------------
    def _jr(
        self,
        sha: str,
        name: str,
        conclusion: str,
        *,
        rule: str = "",
        status: str = "completed",
        t: datetime | None = None,
    ) -> JobResult:
        return JobResult(
            head_sha=sha,
            name=name,
            conclusion=conclusion,
            status=status,
            classification_rule=rule,
            workflow_created_at=t or datetime.now(),
        )

    def _cj(self, sha: str, t: datetime, jobs: list[JobResult]) -> CommitJobs:
        return CommitJobs(head_sha=sha, created_at=t, jobs=jobs)

    def test_no_newer_commit_with_same_job(self):
        # Newest has build only; suspected (mid) fails a test job; older has same test job success
        now = datetime.now()
        sha_new, sha_mid, sha_old = "a" * 40, "b" * 40, "c" * 40
        build = "linux / build"
        test_a = "linux / test (shard A)"

        cj_new = self._cj(sha_new, now, [self._jr(sha_new, build, "success")])
        cj_mid = self._cj(
            sha_mid,
            now.replace(microsecond=0),
            [self._jr(sha_mid, test_a, "failure", rule="pytest failure")],
        )
        cj_old = self._cj(sha_old, now, [self._jr(sha_old, test_a, "success")])

        checker = AutorevertPatternChecker(["synthetic"], lookback_hours=1)
        checker._workflow_commits_cache["synthetic"] = [cj_new, cj_mid, cj_old]
        patterns = checker.detect_autorevert_pattern_workflow("synthetic")
        self.assertEqual(len(patterns), 0)

    def test_two_newer_commits_with_different_failures(self):
        # Newest fails same job but different rule than suspected commit
        now = datetime.now()
        sha_new, sha_mid, sha_old = "d" * 40, "e" * 40, "f" * 40
        test_a = "linux / test (shard A)"

        cj_new = self._cj(
            sha_new,
            now,
            [self._jr(sha_new, test_a, "failure", rule="GHA error")],
        )
        cj_mid = self._cj(
            sha_mid,
            now,
            [self._jr(sha_mid, test_a, "failure", rule="pytest failure")],
        )
        cj_old = self._cj(sha_old, now, [self._jr(sha_old, test_a, "success")])

        checker = AutorevertPatternChecker(["synthetic2"], lookback_hours=1)
        checker._workflow_commits_cache["synthetic2"] = [cj_new, cj_mid, cj_old]
        patterns = checker.detect_autorevert_pattern_workflow("synthetic2")
        self.assertEqual(len(patterns), 0)

    def test_all_commits_have_same_failure_no_baseline(self):
        # All three commits fail same job/rule; baseline isn't clean => no pattern
        now = datetime.now()
        sha_new, sha_mid, sha_old = "g" * 40, "h" * 40, "i" * 40
        test_a = "linux / test (shard A)"

        def failing(sha):
            return self._jr(sha, test_a, "failure", rule="pytest failure")

        cj_new = self._cj(sha_new, now, [failing(sha_new)])
        cj_mid = self._cj(sha_mid, now, [failing(sha_mid)])
        cj_old = self._cj(sha_old, now, [failing(sha_old)])

        checker = AutorevertPatternChecker(["synthetic3"], lookback_hours=1)
        checker._workflow_commits_cache["synthetic3"] = [cj_new, cj_mid, cj_old]
        patterns = checker.detect_autorevert_pattern_workflow("synthetic3")
        self.assertEqual(len(patterns), 0)

    def test_missing_older_commit_with_same_job(self):
        # Older commit doesn't have the same normalized job => no pattern
        now = datetime.now()
        sha_new, sha_mid, sha_old = "j" * 40, "k" * 40, "l" * 40
        test_a = "linux / test (shard A)"
        other = "linux / doc-job"

        cj_new = self._cj(
            sha_new, now, [self._jr(sha_new, test_a, "failure", rule="pytest failure")]
        )
        cj_mid = self._cj(
            sha_mid, now, [self._jr(sha_mid, test_a, "failure", rule="pytest failure")]
        )
        cj_old = self._cj(sha_old, now, [self._jr(sha_old, other, "success")])

        checker = AutorevertPatternChecker(["synthetic4"], lookback_hours=1)
        checker._workflow_commits_cache["synthetic4"] = [cj_new, cj_mid, cj_old]
        patterns = checker.detect_autorevert_pattern_workflow("synthetic4")
        self.assertEqual(len(patterns), 0)

    def test_only_two_commits_in_list(self):
        # With < 3 commits, function should return [] (early guard)
        now = datetime.now()
        sha_new, sha_mid = "m" * 40, "n" * 40
        test_a = "linux / test (shard A)"

        cj_new = self._cj(
            sha_new, now, [self._jr(sha_new, test_a, "failure", rule="pytest failure")]
        )
        cj_mid = self._cj(
            sha_mid, now, [self._jr(sha_mid, test_a, "failure", rule="pytest failure")]
        )
        checker = AutorevertPatternChecker(["synthetic5"], lookback_hours=1)
        checker._workflow_commits_cache["synthetic5"] = [cj_new, cj_mid]
        patterns = checker.detect_autorevert_pattern_workflow("synthetic5")
        self.assertEqual(len(patterns), 0)

    def test_primary_pattern_detection(self):
        checker = AutorevertPatternChecker(["trunk"], lookback_hours=72)
        patterns = checker.detect_autorevert_pattern_workflow("trunk")
        self.assertGreaterEqual(len(patterns), 1)
        p = patterns[0]
        self.assertEqual(p["workflow_name"], "trunk")
        self.assertEqual(p["failure_rule"], "pytest failure")
        self.assertEqual(
            p["newer_commits"][1], "bbc0df1094b5a4dcd2cce83f8402127b07913231"
        )
        self.assertEqual(p["older_commit"], "33ec6e3e9aa2b93f7d907236aa10ba2b36355018")

    def test_secondary_confirmation_on_restarted(self):
        checker = AutorevertPatternChecker(["trunk"], lookback_hours=72)
        patterns = checker.detect_autorevert_pattern_workflow("trunk")
        self.assertTrue(patterns)
        ok = checker.confirm_commit_caused_failure_on_restarted(patterns[0])
        self.assertTrue(ok)

    def test_secondary_confirmation_blocks_on_pending(self):
        pattern = {
            "workflow_name": "trunk",
            "failure_rule": "pytest failure",
            "job_name_base": "linux-jammy-rocm-py3.10 / test",
            "newer_commits": [
                "deadbeef" * 5,
                "bbc0df1094b5a4dcd2cce83f8402127b07913231",
            ],
            "older_commit": "pending_prev",
        }
        checker = AutorevertPatternChecker(["trunk"], lookback_hours=72)
        ok = checker.confirm_commit_caused_failure_on_restarted(pattern)
        self.assertFalse(ok)

    def test_revert_detection_and_categories(self):
        checker = AutorevertPatternChecker(["trunk"], lookback_hours=72)
        info = checker.is_commit_reverted("bbc0df1094b5a4dcd2cce83f8402127b07913231")
        self.assertIsNotNone(info)
        self.assertTrue(info["reverted"])
        with_info = checker.commits_reverted_with_info
        self.assertIn("bbc0df1094b5a4dcd2cce83f8402127b07913231", with_info)
        self.assertEqual(
            with_info["bbc0df1094b5a4dcd2cce83f8402127b07913231"].get("category"),
            "ghfirst",
        )

    def test_pattern_not_detected_when_baseline_pending(self):
        checker = AutorevertPatternChecker(["trunk-pending"], lookback_hours=72)
        patterns = checker.detect_autorevert_pattern_workflow("trunk-pending")
        self.assertEqual(
            len(patterns), 0, "No pattern when baseline job has pending status"
        )

    def test_pattern_not_detected_when_baseline_fails(self):
        checker = AutorevertPatternChecker(["trunk-baseline-fails"], lookback_hours=72)
        patterns = checker.detect_autorevert_pattern_workflow("trunk-baseline-fails")
        self.assertEqual(
            len(patterns), 0, "No pattern when baseline also fails with same rule"
        )

    def test_pattern_not_detected_with_insufficient_failures(self):
        checker = AutorevertPatternChecker(["trunk-one-failure"], lookback_hours=72)
        patterns = checker.detect_autorevert_pattern_workflow("trunk-one-failure")
        self.assertEqual(
            len(patterns), 0, "No pattern when only one newer commit fails"
        )

    def test_restart_checker_dedup_and_dispatch(self):
        rc = WorkflowRestartChecker()
        self.assertTrue(
            rc.has_restarted_workflow(
                "trunk", "bbc0df1094b5a4dcd2cce83f8402127b07913231"
            )
        )

    def test_event_logger_inserts(self):
        before = len(self.fake_ch.inserts)
        log_autorevert_event(
            workflow="trunk",
            action="detected",
            first_failing_sha="bbc0df1",
            previous_sha="33ec6e3",
            failure_rule="pytest failure",
            job_name_base="linux-jammy-rocm-py3.10 / test",
            second_failing_sha="4fd5fab",
            dry_run=True,
            notes="unit-test",
        )
        after = len(self.fake_ch.inserts)
        self.assertEqual(after, before + 1)
        last = self.fake_ch.inserts[-1]
        self.assertEqual(last["table"], "autorevert_events")
        self.assertEqual(last["database"], "misc")
        self.assertEqual(
            last["columns"][0:4],
            ["workflow", "action", "first_failing_sha", "previous_sha"],
        )


if __name__ == "__main__":
    unittest.main()
