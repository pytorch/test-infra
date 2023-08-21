import unittest
from update_test_times import gen_test_times


class TestUpdateTestTimes(unittest.TestCase):
    def make_rockset_row(self, job: str, config: str, file: str, time: float):
        return {"base_name": job, "test_config": config, "file": file, "time": time}

    def test_gen_test_times_create_default(self) -> None:
        data = [
            self.make_rockset_row("job", "config", "a", 1),
            self.make_rockset_row("job", "config", "b", 1),
            self.make_rockset_row("job", "config", "c", 1),
        ]
        res = gen_test_times(data)
        expected = {
            "job": {"config": {"a": 1, "b": 1, "c": 1}},
            "default": {
                "config": {"a": 1.0, "b": 1.0, "c": 1.0},
                "default": {"a": 1.0, "b": 1.0, "c": 1.0},
            },
        }
        self.assertDictEqual(res, expected)

    def test_gen_test_times_defaults_average(self) -> None:
        data = [
            self.make_rockset_row("job", "config", "a", 1),
            self.make_rockset_row("job", "config2", "a", 6),
            self.make_rockset_row("job2", "config", "a", 5),
        ]
        res = gen_test_times(data)
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

    def test_gen_test_times_dont_override_default(self) -> None:
        data = [
            self.make_rockset_row("default", "config", "a", 1),
            self.make_rockset_row("job", "config", "a", 6),
            self.make_rockset_row("default", "default", "a", 5),
        ]
        res = gen_test_times(data)
        expected = {
            "job": {
                "config": {"a": 6.0},
            },
            "default": {"default": {"a": 5.0}, "config": {"a": 1.0}},
        }

        self.assertDictEqual(res, expected)


if __name__ == "__main__":
    unittest.main()
