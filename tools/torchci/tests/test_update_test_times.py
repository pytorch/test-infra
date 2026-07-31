import re
import unittest
from unittest.mock import patch

from torchci.update_test_times import gen_test_class_times, gen_test_file_times
from torchci.utils import REPO_ROOT


# The (base_name, test_config) keys are extracted by these RE2 patterns in the
# saved ClickHouse test_times queries. Mirrored here so we can exercise their
# behavior; the test_queries_embed_expected_patterns guard fails if a query
# stops using them, so the two can't silently drift.
QUERY_DIRS = [
    "per_file",
    "per_file_periodic_jobs",
    "per_class",
    "per_class_periodic_jobs",
]
BASE_NAME_RE = r"^(.*) /"
TEST_CONFIG_RE = r"/ test(?:-osdc)? \(([\w-]*),"


def _query_path(name: str):
    return (
        REPO_ROOT / "torchci" / "clickhouse_queries" / "test_times" / name / "query.sql"
    )


@patch("torchci.update_test_times.clean_up_test_times", lambda x: x)
class TestUpdateTestTimesFile(unittest.TestCase):
    def make_db_row(self, job: str, config: str, file: str, time: float):
        return {"base_name": job, "test_config": config, "file": file, "time": time}

    def test_gen_test_file_times_create_default(self) -> None:
        data = [
            self.make_db_row("job", "config", "a", 1),
            self.make_db_row("job", "config", "b", 1),
            self.make_db_row("job", "config", "c", 1),
        ]
        res = gen_test_file_times(data, {})
        expected = {
            "job": {"config": {"a": 1, "b": 1, "c": 1}},
            "default": {
                "config": {"a": 1.0, "b": 1.0, "c": 1.0},
                "default": {"a": 1.0, "b": 1.0, "c": 1.0},
            },
        }
        self.assertDictEqual(res, expected)

    def test_gen_test_file_times_defaults_average(self) -> None:
        data = [
            self.make_db_row("job", "config", "a", 1),
            self.make_db_row("job", "config2", "a", 6),
            self.make_db_row("job2", "config", "a", 5),
        ]
        res = gen_test_file_times(data, {})
        expected = {
            "job": {"config": {"a": 1}, "config2": {"a": 6}},
            "job2": {"config": {"a": 5}},
            "default": {
                "config": {"a": 3.0},
                "config2": {"a": 6.0},
                "default": {"a": 4.0},
            },
        }

        self.assertDictEqual(res, expected)

    def test_gen_test_file_times_override_default(self) -> None:
        data = [
            self.make_db_row("default", "config", "a", 1),
            self.make_db_row("job", "config", "a", 6),
            self.make_db_row("default", "default", "a", 5),
        ]
        res = gen_test_file_times(data, {})
        expected = {
            "default": {"config": {"a": 3.5}, "default": {"a": 4.0}},
            "job": {"config": {"a": 6}},
        }
        self.assertDictEqual(res, expected)

    def test_gen_test_file_times_override_old_default(self) -> None:
        data = [
            self.make_db_row("default", "config", "a", 1),
            self.make_db_row("job", "config", "a", 6),
            self.make_db_row("default", "default", "a", 5),
        ]
        res = gen_test_file_times(data, {"default": {"config": {"a": 57}}})
        expected = {
            "default": {"config": {"a": 3.5}, "default": {"a": 4.0}},
            "job": {"config": {"a": 6}},
        }
        self.assertDictEqual(res, expected)

        data = [
            self.make_db_row("env", "config", "a", 1),
        ]
        res = gen_test_file_times(
            data, {"default": {"config": {"a": 57}, "default": {"a": 100}}}
        )
        expected = {
            "default": {"config": {"a": 1.0}, "default": {"a": 1.0}},
            "env": {"config": {"a": 1}},
        }
        self.assertDictEqual(res, expected)

        data = []
        res = gen_test_file_times(data, {"default": {"config": {"a": 57}}})
        # When having no data, the old default should be kept
        expected = {"default": {"config": {"a": 57}}}
        self.assertDictEqual(res, expected)

    def test_gen_test_file_times_old_values_still_present(self) -> None:
        data = [
            self.make_db_row("env", "config", "a", 5),
        ]
        res = gen_test_file_times(data, {"env": {"config": {"b": 57}}})
        expected = {
            "env": {"config": {"b": 57, "a": 5}},
            "default": {"config": {"a": 5.0}, "default": {"a": 5.0}},
        }
        self.assertDictEqual(res, expected)


@patch("torchci.update_test_times.clean_up_test_times", lambda x: x)
class TestUpdateTestTimesClass(unittest.TestCase):
    def make_db_row(
        self, job: str, config: str, file: str, classname: str, time: float
    ):
        return {
            "base_name": job,
            "test_config": config,
            "file": file,
            "classname": classname,
            "time": time,
        }

    def test_gen_test_class_times_create_default(self) -> None:
        data = [
            self.make_db_row("job", "config", "a", "classa", 1),
            self.make_db_row("job", "config", "a", "classb", 1),
            self.make_db_row("job", "config", "c", "classc", 1),
        ]
        res = gen_test_class_times(data, {})
        expected = {
            "job": {"config": {"a": {"classa": 1, "classb": 1}, "c": {"classc": 1}}},
            "default": {
                "config": {"a": {"classa": 1.0, "classb": 1.0}, "c": {"classc": 1.0}},
                "default": {"a": {"classa": 1.0, "classb": 1.0}, "c": {"classc": 1.0}},
            },
        }
        self.assertDictEqual(res, expected)

    def test_gen_test_class_times_defaults_average(self) -> None:
        self.maxDiff = None
        data = [
            self.make_db_row("job", "config", "a", "classa", 1),
            self.make_db_row("job", "config2", "a", "classa", 6),
            self.make_db_row("job2", "config", "a", "classa", 5),
        ]
        res = gen_test_class_times(data, {})
        expected = {
            "job": {"config": {"a": {"classa": 1}}, "config2": {"a": {"classa": 6}}},
            "job2": {"config": {"a": {"classa": 5}}},
            "default": {
                "config": {"a": {"classa": 3.0}},
                "config2": {"a": {"classa": 6.0}},
                "default": {"a": {"classa": 4.0}},
            },
        }

        self.assertDictEqual(res, expected)

    def test_gen_test_class_times_override_default(self) -> None:
        data = [
            self.make_db_row("default", "config", "a", "classa", 1),
            self.make_db_row("job", "config", "a", "classa", 6),
            self.make_db_row("default", "default", "a", "classa", 5),
        ]
        res = gen_test_class_times(data, {})
        expected = {
            "default": {
                "config": {"a": {"classa": 3.5}},
                "default": {"a": {"classa": 4.0}},
            },
            "job": {"config": {"a": {"classa": 6}}},
        }
        self.assertDictEqual(res, expected)

    def test_gen_test_class_times_override_old_default(self) -> None:
        self.maxDiff = None
        data = [
            self.make_db_row("default", "config", "a", "classa", 1),
            self.make_db_row("job", "config", "a", "classa", 6),
            self.make_db_row("default", "default", "a", "classa", 5),
        ]
        res = gen_test_class_times(data, {"default": {"config": {"a": {"classa": 57}}}})
        expected = {
            "default": {
                "config": {"a": {"classa": 3.5}},
                "default": {"a": {"classa": 4.0}},
            },
            "job": {"config": {"a": {"classa": 6}}},
        }
        self.assertDictEqual(res, expected)

        data = [
            self.make_db_row("env", "config", "a", "classa", 1),
        ]
        res = gen_test_class_times(
            data,
            {
                "default": {
                    "config": {"a": {"classa": 57}},
                    "default": {"a": {"classa": 100}},
                }
            },
        )
        expected = {
            "default": {
                "config": {"a": {"classa": 1.0}},
                "default": {"a": {"classa": 1.0}},
            },
            "env": {"config": {"a": {"classa": 1}}},
        }
        self.assertDictEqual(res, expected)

    def test_gen_test_class_times_old_values_still_present(self) -> None:
        data = [
            self.make_db_row("env", "config", "a", "classa", 5),
        ]
        res = gen_test_class_times(data, {"env": {"config": {"b": {"classb": 57}}}})
        expected = {
            "env": {"config": {"b": {"classb": 57}, "a": {"classa": 5}}},
            "default": {
                "config": {"a": {"classa": 5.0}},
                "default": {"a": {"classa": 5.0}},
            },
        }
        self.assertDictEqual(res, expected)


class TestCleanUpOldBuildEnvs(unittest.TestCase):
    def make_db_row(self, job: str, config: str, file: str, time: float):
        return {"base_name": job, "test_config": config, "file": file, "time": time}

    def test_clean_up_simple(self) -> None:
        # Simple test to make sure the other build envs are removed
        data = [
            self.make_db_row("job1", "config", "a", 1),
            self.make_db_row("job2", "config", "a", 1),
            self.make_db_row("job3", "config", "a", 1),
        ]
        with patch(
            "torchci.update_test_times.query_clickhouse_saved",
            return_value=[{"base_name": "job1"}],
        ):
            res = gen_test_file_times(data, {})
            expected = {
                "job1": {"config": {"a": 1}},
                "default": {
                    "config": {
                        "a": 1.0,
                    },
                    "default": {
                        "a": 1.0,
                    },
                },
            }
            self.assertDictEqual(res, expected)


class TestJobNameExtractionSql(unittest.TestCase):
    # (job name, expected base_name, expected test_config)
    CASES = [
        (
            "linux-jammy-py3.10-clang18 / test (dynamo_wrapped, 1, 3, lf-l-x86)",
            "linux-jammy-py3.10-clang18",
            "dynamo_wrapped",
        ),
        (
            "linux-jammy-py3.14t-clang18 / test-osdc (dynamo_wrapped, 1, 3, mt-l-x86)",
            "linux-jammy-py3.14t-clang18",
            "dynamo_wrapped",
        ),
        (
            "cross-compile-linux-test-cuda13 / test-osdc (aoti, 1, 1, r, win)",
            "cross-compile-linux-test-cuda13",
            "aoti",
        ),
        # Multi-segment prefix is kept.
        (
            "unit-test / inductor-test / test-osdc (inductor, 2, 2, mt-l-x86)",
            "unit-test / inductor-test",
            "inductor",
        ),
        # Non-test/test-osdc targets yield no config (must match "test-osdc" exactly,
        # not as a prefix); an empty config field also renders as "".
        ("env / test-foo (default, 1, 1, r)", "env", ""),
        ("env / testbar (default, 1, 1, r)", "env", ""),
        ("env / test-osdcfoo (default, 1, 1, r)", "env", ""),
        ("env / inductor-cpu-core-test (3.11)", "env", ""),
        ("env / build", "env", ""),
        ("env / test (, 1, 2, r)", "env", ""),
    ]

    # Patterns run in ClickHouse (RE2); this mirrors them with Python re. Keep them
    # RE2-safe -- verify any pattern change against ClickHouse directly.
    def _apply(self, pattern: str, job_name: str) -> str:
        m = re.search(pattern, job_name)
        return m.group(1) if m else ""

    def test_queries_embed_expected_patterns(self) -> None:
        # Each pattern is a single-quoted SQL string literal, so this substring
        # check is robust to query reformatting (line wraps happen outside it).
        for name in QUERY_DIRS:
            sql = _query_path(name).read_text()
            with self.subTest(query=name):
                self.assertIn(BASE_NAME_RE, sql)
                self.assertIn(TEST_CONFIG_RE, sql)

    def test_patterns_extract_consistently(self) -> None:
        for job_name, want_base, want_cfg in self.CASES:
            with self.subTest(job=job_name):
                self.assertEqual(self._apply(BASE_NAME_RE, job_name), want_base)
                self.assertEqual(self._apply(TEST_CONFIG_RE, job_name), want_cfg)


if __name__ == "__main__":
    unittest.main()
