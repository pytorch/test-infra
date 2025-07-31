import unittest
from unittest.mock import patch

from torchci.update_test_times import gen_test_class_times, gen_test_file_times


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


if __name__ == "__main__":
    unittest.main()
