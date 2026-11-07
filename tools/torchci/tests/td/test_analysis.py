import unittest

import pytest


pd = pytest.importorskip("pandas")
np = pytest.importorskip("numpy")
pytest.importorskip("sklearn")

from torchci.td.analysis import config, labels, models, policies  # noqa: E402


class TestPolicies(unittest.TestCase):
    def test_cut_matches_get_top_per_tests(self) -> None:
        # get_top_per_tests keeps index < 25 * n // 100 + 1.
        for n in (1, 3, 4, 7, 100, 1147):
            self.assertEqual(policies.cut_size(n, 25), 25 * n // 100 + 1)
        self.assertEqual(policies.cut_size(10, 100), 10)

    def test_ties_break_by_name(self) -> None:
        self.assertEqual(
            policies.ranked({"b": 1.0, "a": 1.0, "c": 2.0}, ["a", "b", "c", "d"]),
            ["c", "a", "b", "d"],
        )

    def test_explore_time_is_deterministic_and_within_budget(self) -> None:
        tests = [f"t{i}" for i in range(400)]
        scores = {t: 1.0 / (i + 1) for i, t in enumerate(tests)}
        seconds = {t: 1.0 + (i % 7) * 3 for i, t in enumerate(tests)}
        order = policies.by_value(scores, tests, seconds)
        a = policies.explore_time(order, seconds, scores, 0.2, 0.05, "c:abc")
        b = policies.explore_time(order, seconds, scores, 0.2, 0.05, "c:abc")
        self.assertEqual(a, b)
        total = sum(seconds.values())
        self.assertLessEqual(
            sum(seconds[t] for t in a), 0.2 * total + max(seconds.values())
        )
        head = set(policies.time_select(order, seconds, 0.2 * 0.95))
        self.assertTrue(head < a)


class TestSilver(unittest.TestCase):
    def jobs(self, push: str, conclusion: str = "success") -> list[dict]:
        return [
            {
                "push_sha": push,
                "workflow": "pull",
                "build_environment": "linux",
                "test_config": "default",
                "shard": s,
                "shards": 2,
                "conclusion": conclusion,
                "completed_at": 0,
                "job_id": hash((push, s)),
            }
            for s in (1, 2)
        ]

    def run_silver(
        self, fails: dict[str, list[str]], missing_shard: str = ""
    ) -> set[tuple[str, str]]:
        order = ["p0", "p1", "p2", "p3", "p4"]
        pushes = pd.DataFrame({"push_sha": order, "pushed_at": range(len(order))})
        jobs = pd.DataFrame(
            [
                j
                for p in order
                for j in self.jobs(p)
                if not (p == missing_shard and j["shard"] == 2)
            ]
        )
        fail = pd.DataFrame(
            [
                {
                    "push_sha": p,
                    "workflow": "pull",
                    "build_environment": "linux",
                    "test_config": "default",
                    "file": f,
                    "completed_at": 0,
                }
                for p, fs in fails.items()
                for f in fs
            ],
            columns=[
                "push_sha",
                "workflow",
                "build_environment",
                "test_config",
                "file",
                "completed_at",
            ],
        )
        df = labels.silver(pushes, jobs, fail)
        return set(zip(df["push_sha"], df["file"]))

    def test_new_and_repeated(self) -> None:
        self.assertEqual(
            self.run_silver({"p2": ["test_a"], "p3": ["test_a"]}), {("p2", "test_a")}
        )

    def test_flake_is_not_new(self) -> None:
        self.assertEqual(self.run_silver({"p2": ["test_a"]}), set())

    def test_already_failing_before(self) -> None:
        self.assertEqual(
            self.run_silver({"p1": ["test_a"], "p2": ["test_a"], "p3": ["test_a"]}),
            {("p1", "test_a")},
        )

    def test_unreported_previous_push(self) -> None:
        self.assertEqual(
            self.run_silver({"p2": ["test_a"], "p3": ["test_a"]}, missing_shard="p1"),
            set(),
        )


class TestBudget(unittest.TestCase):
    def test_mean_budget_hits_target(self) -> None:
        risk = np.random.default_rng(0).random(5000) ** 3
        for target in config.BUDGET_TARGETS:
            ref, g = models.budget_curve(risk, target)
            k = models.budget(ref, g, risk)
            self.assertLessEqual(abs(k.mean() - target), 0.5)
            self.assertGreaterEqual(k.min(), config.BUDGET_MIN)
            self.assertLessEqual(k.max(), config.BUDGET_MAX)

    def test_budget_grows_with_risk(self) -> None:
        risk = np.linspace(0, 1, 1000)
        ref, g = models.budget_curve(risk, 20)
        k = models.budget(ref, g, risk)
        self.assertTrue((np.diff(k) >= 0).all())


class TestForwardSplit(unittest.TestCase):
    def test_training_rows_end_before_the_gap(self) -> None:
        units = pd.DataFrame(
            {
                "unit_id": ["a", "b", "c"],
                "time": [100, 200, 300],
                "train_ok": [True, True, False],
            }
        )
        rows = pd.DataFrame(
            {"unit_id": ["a", "a", "b", "c"], "y": [1.0, 0.0, np.nan, 1.0]}
        )
        got = models.training_rows(rows, units, before=250)
        self.assertEqual(set(got["unit_id"]), {"a"})
        self.assertTrue((got["w"] > 0).all())


class TestAfter(unittest.TestCase):
    def unit(self, scale: float):
        from torchci.td.analysis.selection import Unit

        tests = [f"t{i}" for i in range(40)]
        u = Unit(
            "c:abc",
            tests,
            {t: 1.0 / (i + 1) for i, t in enumerate(tests)},
            {t: 1.0 / (40 - i) for i, t in enumerate(tests)},
            {t: float(1 + i % 5) for i, t in enumerate(tests)},
        )
        u.add_adaptive(scale)
        return u

    def test_budget_is_scaled_and_capped(self) -> None:
        small, big = self.unit(0.75), self.unit(1.75)
        self.assertLess(
            small.share("adaptive_time@20")[1], big.share("adaptive_time@20")[1]
        )
        self.assertEqual(big.sel["adaptive_time@100"], set(big.tests))
        self.assertLess(len(small.sel["adaptive_time@100"]), len(small.tests))

    def test_td_matched_budget_follows_td_time(self) -> None:
        u = self.unit(1.0)
        td_time = u.share("before@25")[1]
        got = u.share("adaptive_time@td25")[1]
        self.assertLessEqual(
            got, td_time + max(u.seconds.values()) / sum(u.seconds.values())
        )

    def test_time_scales_average_one_per_population_and_week(self) -> None:
        from torchci.td.analysis.evaluate import DAY, time_scales

        ids = ["m1", "m2", "p1", "p2", "p3", "m3", "m4"]
        t = config.BUDGET_TARGETS[0]
        risk = pd.DataFrame(
            {"unit_id": ids[:4] + ids[5:], f"budget_{t}": [15, 35, 20, 30, 15, 17]}
        )
        ev = pd.DataFrame(
            {
                "kind": ["main", "main", "pr_off", "pr_on", "pr_off", "main", "main"],
                "time": [0, DAY, 0, DAY, 2 * DAY, 8 * DAY, 9 * DAY],
            },
            index=ids,
        )
        got = time_scales(risk, ev, dict.fromkeys(ids))
        self.assertAlmostEqual((got["m1"] + got["m2"]) / 2, 1.0)
        self.assertAlmostEqual((got["p1"] + got["p2"] + got["p3"]) / 3, 1.0)
        self.assertAlmostEqual((got["m3"] + got["m4"]) / 2, 1.0)
        self.assertGreater(got["m2"], got["m1"])

    def test_names(self) -> None:
        from torchci.td.analysis.selection import name

        self.assertEqual(name("before@25"), "TD, 25% of test files")
        self.assertEqual(
            name("adaptive_time@20"),
            "After with a time budget, 20% of test time, scaled per change",
        )
        self.assertEqual(
            name("adaptive_time@td25"), "After with a time budget, TD's test time today"
        )


class TestOldRatings(unittest.TestCase):
    def test_coedit_counts_each_commit_by_its_size(self) -> None:
        from torchci.td.analysis.ratings import DAY, rebuild_coedit_old

        day = 400 * DAY
        commits = [
            (day - DAY, ["a.py", "test/test_x.py"]),
            (day - 2 * DAY, ["a.py", "b.py", "test/test_x.py", "test/test_y.py"]),
            (day - 400 * DAY, ["a.py", "test/test_x.py"]),
            (day + DAY, ["a.py", "test/test_x.py"]),
        ]
        got = rebuild_coedit_old(commits, {"test_x", "test_y"}, day)
        self.assertAlmostEqual(got["a.py"]["test_x"], 1 / 2 + 1 / 4)
        self.assertAlmostEqual(got["b.py"]["test_y"], 1 / 4)
        self.assertNotIn("c.py", got)

    def test_fail_counts_each_breaking_commit_once_undecayed(self) -> None:
        from torchci.td.analysis.ratings import DAY, rebuild_fail_old

        day = 200 * DAY
        merge_bases = {
            "s1": {"merge_base": "m", "changed_files": ["a.py", "b.py"]},
            "s2": {"merge_base": "m", "changed_files": ["a.py"]},
            "m": {"merge_base": "m0", "changed_files": []},
        }
        history = [
            {"head_sha": "s1", "failure": "test_x", "ts": day - 80 * DAY},
            {"head_sha": "s1", "failure": "test_x", "ts": day - 79 * DAY},
            {"head_sha": "s2", "failure": "test_x", "ts": day - DAY},
            {"head_sha": "s2", "failure": "test_y", "ts": day - 100 * DAY},
        ]
        got = rebuild_fail_old(history, merge_bases, day)
        self.assertAlmostEqual(got["a.py"]["test_x"], 1 / 2 + 1)
        self.assertAlmostEqual(got["b.py"]["test_x"], 1 / 2)
        self.assertNotIn("test_y", got["a.py"])


class TestBreakdowns(unittest.TestCase):
    def test_random_catch(self) -> None:
        from torchci.td.analysis.breakdowns import random_catch

        self.assertAlmostEqual(random_catch(4, 1, 1), 0.25)
        self.assertAlmostEqual(random_catch(4, 2, 1), 0.5)
        self.assertEqual(random_catch(4, 1, 4), 1.0)

    def test_caught_at_cut_ranks_within_units(self) -> None:
        df = pd.DataFrame(
            {
                "unit_id": ["u"] * 4 + ["v"] * 4,
                "test": list("abcd") * 2,
                "y": [1, 0, 0, 0, 0, 0, 0, 1.0],
            }
        )
        p = np.array([0.1, 0.9, 0.5, 0.2, 0.9, 0.8, 0.7, 0.6])
        got = models.caught_at_cut(df, p)
        # 25% of 4 tests keeps positions 0 and 1 (get_top_per_tests): u's failing test
        # ranks last, v's last as well.
        self.assertEqual(list(got), [False, False])


if __name__ == "__main__":
    unittest.main()
