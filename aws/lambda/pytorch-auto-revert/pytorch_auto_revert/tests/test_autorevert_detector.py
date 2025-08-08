import unittest
from datetime import datetime, timedelta

from pytorch_auto_revert.autorevert_checker import (
    AutorevertPatternChecker,
    CommitJobs,
    JobResult,
)


class TestAutorevertDetectorROCM(unittest.TestCase):
    def _make_job(self, sha, name, conclusion, rule="", status="completed", t=None):
        return JobResult(
            head_sha=sha,
            name=name,
            conclusion=conclusion,
            status=status,
            classification_rule=rule,
            workflow_created_at=t or datetime.now(),
        )

    def test_rocm_realnames_success_rule_noise(self):
        # Simulate the real ROCm case from ClickHouse where the baseline commit
        # has success jobs but with rule='pytest failure', and two newer commits
        # have single-shard failures with rule='pytest failure'.

        now = datetime.now()
        sha_old = "33ec6e3e9aa2b93f7d907236aa10ba2b36355018"
        sha_mid = "bbc0df1094b5a4dcd2cce83f8402127b07913231"
        sha_new = "4fd5fabee9b2641440a413adf54f728fe2816375"

        # Common job names from the data
        build = "linux-jammy-rocm-py3.10 / build"
        shard1 = "linux-jammy-rocm-py3.10 / test (default, 1, 6, linux.rocm.gpu.2)"
        shard2 = "linux-jammy-rocm-py3.10 / test (default, 2, 6, linux.rocm.gpu.2)"
        shard3 = "linux-jammy-rocm-py3.10 / test (default, 3, 6, linux.rocm.gpu.2)"
        shard4 = "linux-jammy-rocm-py3.10 / test (default, 4, 6, linux.rocm.gpu.2)"
        shard5 = "linux-jammy-rocm-py3.10 / test (default, 5, 6, linux.rocm.gpu.2)"
        shard6 = "linux-jammy-rocm-py3.10 / test (default, 6, 6, linux.rocm.gpu.2)"

        # Old (baseline) commit: all success, but some shards show a rule label
        t_old = now - timedelta(hours=2)
        old_jobs = [
            self._make_job(sha_old, build, "success", t=t_old),
            self._make_job(sha_old, shard1, "success", rule="GHA error", t=t_old),
            self._make_job(sha_old, shard2, "success", rule="pytest failure", t=t_old),
            self._make_job(sha_old, shard3, "success", rule="GHA error", t=t_old),
            self._make_job(sha_old, shard4, "success", rule="pytest failure", t=t_old),
            self._make_job(sha_old, shard5, "success", rule="GHA error", t=t_old),
            self._make_job(sha_old, shard6, "success", rule="pytest failure", t=t_old),
        ]

        # Middle (first failing) commit: shard2 fails with pytest failure
        t_mid = now - timedelta(hours=1)
        mid_jobs = [
            self._make_job(sha_mid, build, "success", t=t_mid),
            self._make_job(sha_mid, shard1, "success", rule="GHA error", t=t_mid),
            self._make_job(sha_mid, shard2, "failure", rule="pytest failure", t=t_mid),
            self._make_job(sha_mid, shard3, "success", rule="pytest failure", t=t_mid),
            self._make_job(sha_mid, shard4, "success", rule="GHA error", t=t_mid),
            self._make_job(sha_mid, shard5, "success", rule="pytest failure", t=t_mid),
            self._make_job(sha_mid, shard6, "success", rule="pytest failure", t=t_mid),
        ]

        # Newest (second failing) commit: shard5 fails with pytest failure
        t_new = now
        new_jobs = [
            self._make_job(sha_new, build, "success", t=t_new),
            self._make_job(sha_new, shard1, "success", rule="GHA error", t=t_new),
            self._make_job(sha_new, shard2, "success", rule="pytest failure", t=t_new),
            self._make_job(sha_new, shard3, "success", rule="GHA error", t=t_new),
            self._make_job(sha_new, shard4, "success", rule="pytest failure", t=t_new),
            self._make_job(sha_new, shard5, "failure", rule="pytest failure", t=t_new),
            self._make_job(sha_new, shard6, "success", rule="GHA error", t=t_new),
        ]

        cj_old = CommitJobs(head_sha=sha_old, created_at=t_old, jobs=old_jobs)
        cj_mid = CommitJobs(head_sha=sha_mid, created_at=t_mid, jobs=mid_jobs)
        cj_new = CommitJobs(head_sha=sha_new, created_at=t_new, jobs=new_jobs)

        # Checker expects commits sorted newest->older; provide in that order
        checker = AutorevertPatternChecker(["rocm"], lookback_hours=48)
        checker._workflow_commits_cache = {"rocm": [cj_new, cj_mid, cj_old]}

        patterns = checker.detect_autorevert_pattern_workflow("rocm")

        self.assertGreaterEqual(len(patterns), 1, "Expected at least one pattern")
        p = patterns[0]
        self.assertEqual(p["workflow_name"], "rocm")
        self.assertEqual(p["failure_rule"], "pytest failure")
        # Order: [newer_commit, suspected_commit]
        self.assertEqual(p["newer_commits"][0], sha_new)
        self.assertEqual(p["newer_commits"][1], sha_mid)
        self.assertEqual(p["older_commit"], sha_old)


if __name__ == "__main__":
    unittest.main()
