import unittest
from datetime import datetime

from pytorch_auto_revert.signal_extraction_types import (
    JobId,
    JobName,
    JobRow,
    RunAttempt,
    Sha,
    WfRunId,
    WorkflowName,
)


def base_name_of(name: str) -> str:
    """Build a JobRow with the given name and return its normalized base_name.

    Only ``name`` affects ``base_name``; the other fields are filler.
    """
    row = JobRow(
        head_sha=Sha("deadbeef"),
        workflow_name=WorkflowName("trunk"),
        wf_run_id=WfRunId(1),
        job_id=JobId(1),
        run_attempt=RunAttempt(1),
        name=JobName(name),
        status="completed",
        conclusion="success",
        started_at=datetime(2024, 1, 1),
        created_at=datetime(2024, 1, 1),
        rule="",
    )
    return str(row.base_name)


class TestJobBaseNameConfigPreserved(unittest.TestCase):
    """Rule 1: a parenthetical with a comma carries a config that is kept."""

    POSITIVE_CASES = {
        # The motivating case: a perf gate must not be folded into siblings.
        "linux-jammy-cuda13.0-py3.10-gcc11 / test (pr_time_benchmarks, 1, 1, lf.linux.g4dn.metal.nvidia.gpu)": (
            "linux-jammy-cuda13.0-py3.10-gcc11 / test (pr_time_benchmarks)"
        ),
        # Standard multi-shard config -> shard idx/total/runner dropped.
        "linux-jammy-rocm-py3.10-mi355 / test (default, 6, 10, linux.rocm.gpu.gfx950.1)": (
            "linux-jammy-rocm-py3.10-mi355 / test (default)"
        ),
        "linux-jammy-rocm-py3.10-mi355 / test (distributed, 2, 4, linux.rocm.gpu.gfx950.2)": (
            "linux-jammy-rocm-py3.10-mi355 / test (distributed)"
        ),
        "win-vs2022-cpu-py3 / test (default, 2, 4, windows.4xlarge.nonephemeral)": (
            "win-vs2022-cpu-py3 / test (default)"
        ),
        "macos-py3-arm64 / test (mps, 1, 1, macos-m1-14)": (
            "macos-py3-arm64 / test (mps)"
        ),
        # Trailing flags (unstable / rerun_disabled_tests / mem_leak_check) drop.
        "linux-jammy-rocm-py3.10-mi355 / test (default, 7, 10, linux.rocm.gpu.gfx950.1, unstable)": (
            "linux-jammy-rocm-py3.10-mi355 / test (default)"
        ),
        "linux-jammy-py3.10-gcc11 / test-osdc (distributed, 3, 3, mt-l-x86iamx-8-64, rerun_disabled_tests)": (
            "linux-jammy-py3.10-gcc11 / test-osdc (distributed)"
        ),
        "linux-jammy-rocm-py3.10-mi355 / test (default, 7, 10, runner, rerun_disabled_tests, unstable)": (
            "linux-jammy-rocm-py3.10-mi355 / test (default)"
        ),
        # No-shard config matrix: (config, runner) with no shard integers.
        "Test collect_env (without_torch, linux.24_04.4x)": "Test collect_env (without_torch)",
        "Test collect_env (older_python_version, linux.24_04.4x)": (
            "Test collect_env (older_python_version)"
        ),
        # Double parenthetical: a build-env (python version) qualifier precedes
        # the real config paren. The version is dropped, the step label and the
        # config are both preserved -- the old greedy regex collapsed all three.
        "unit-test / inductor-cpu-core-test (3.12) / test-osdc (inductor_core, 1, 2, mt-l-x86iavx512-8-64)": (
            "unit-test / inductor-cpu-core-test / test-osdc (inductor_core)"
        ),
        # Long config names survive intact.
        "inductor-cpu-test / test-osdc (inductor_torchbench_cpu_smoketest_perf, 1, 1, mt-l-bx86iamx-92-167)": (
            "inductor-cpu-test / test-osdc (inductor_torchbench_cpu_smoketest_perf)"
        ),
    }

    def test_config_preserved(self):
        for name, expected in self.POSITIVE_CASES.items():
            with self.subTest(name=name):
                self.assertEqual(base_name_of(name), expected)


class TestJobBaseNameAggregationAndSeparation(unittest.TestCase):
    """Shards of one config aggregate; distinct configs stay distinct."""

    def test_shards_of_same_config_aggregate(self):
        step = "linux-jammy-rocm-py3.10-mi355 / test"
        shard1 = f"{step} (default, 1, 10, linux.rocm.gpu.gfx950.1)"
        shard9 = f"{step} (default, 9, 10, linux.rocm.gpu.gfx950.1)"
        self.assertEqual(base_name_of(shard1), base_name_of(shard9))
        self.assertEqual(base_name_of(shard1), f"{step} (default)")

    def test_retry_attempt_does_not_change_key(self):
        # A rerun on a different runner is still the same config signal.
        a = "macos-py3-arm64 / test (default, 1, 3, macos-m1-stable)"
        b = "macos-py3-arm64 / test (default, 1, 3, macos-m2-15, rerun_disabled_tests)"
        self.assertEqual(base_name_of(a), base_name_of(b))

    def test_distinct_configs_get_distinct_keys(self):
        step = "linux-jammy-cuda13.0-py3.10-gcc11 / test"
        keys = {
            base_name_of(f"{step} (default, 1, 5, r)"),
            base_name_of(f"{step} (distributed, 1, 3, r)"),
            base_name_of(f"{step} (pr_time_benchmarks, 1, 1, r)"),
        }
        # Three configs -> three separate signal keys (the core fix).
        self.assertEqual(len(keys), 3)


class TestJobBaseNameNoConfig(unittest.TestCase):
    """Rule 2: no comma-bearing paren -> drop all parens and group."""

    NEGATIVE_CASES = {
        # No parenthetical at all (build / lint jobs) -> unchanged.
        "linux-jammy-py3.10-gcc11 / build": "linux-jammy-py3.10-gcc11 / build",
        "lintrunner-clang / lint": "lintrunner-clang / lint",
        "linux-docs / build-docs (cpp)": "linux-docs / build-docs",
        # Version-only qualifier (no config paren) -> version dropped, so
        # 3.11/3.12/3.13 variants intentionally merge into one signal.
        "unit-test / inductor-cpu-core-test (3.12) / test": (
            "unit-test / inductor-cpu-core-test / test"
        ),
        "unit-test / inductor-cpu-core-build (3.11) / build-osdc": (
            "unit-test / inductor-cpu-core-build / build-osdc"
        ),
        # Single-token paren (no comma) is treated as a qualifier, not a config.
        "linux-jammy-rocm-py3.10 / test (rocm)": "linux-jammy-rocm-py3.10 / test",
    }

    def test_no_config_dropped(self):
        for name, expected in self.NEGATIVE_CASES.items():
            with self.subTest(name=name):
                self.assertEqual(base_name_of(name), expected)

    def test_python_version_variants_merge(self):
        keys = {
            base_name_of("unit-test / inductor-cpu-core-test (3.11) / test"),
            base_name_of("unit-test / inductor-cpu-core-test (3.12) / test"),
            base_name_of("unit-test / inductor-cpu-core-test (3.13) / test"),
        }
        self.assertEqual(len(keys), 1)


class TestJobBaseNameWeirdInputs(unittest.TestCase):
    """Defensive cases: empty / malformed / unusual names must not crash."""

    def test_empty_name(self):
        self.assertEqual(base_name_of(""), "")

    def test_only_a_config_paren(self):
        self.assertEqual(base_name_of("(default, 1, 2, runner)"), "(default)")

    def test_unbalanced_open_paren_passes_through(self):
        # No closing paren and no comma-config match -> returned cleaned as-is.
        self.assertEqual(base_name_of("foo / test (bar"), "foo / test (bar")

    def test_empty_parens(self):
        self.assertEqual(base_name_of("foo / test ()"), "foo / test")

    def test_whitespace_collapsed(self):
        self.assertEqual(
            base_name_of("foo  /   test   (default, 1, 2, r)"), "foo / test (default)"
        )

    def test_leading_space_in_config_token_is_trimmed(self):
        self.assertEqual(
            base_name_of("foo / test ( default , 1, 2, r)"), "foo / test (default)"
        )

    def test_first_comma_paren_wins_when_multiple(self):
        # Defensive: not observed in the live corpus, but document the behavior
        # -- the first comma-bearing parenthetical supplies the config.
        self.assertEqual(
            base_name_of("a / test (b, 1, 1, r) (c, 2, 2, r)"), "a / test (b)"
        )


if __name__ == "__main__":
    unittest.main()
