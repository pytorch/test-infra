import math
import subprocess
import tempfile
import time
from pathlib import Path
from unittest import main, mock, TestCase

from torchci.td.labels.schema import DAY
from torchci.td.scorer import gitdata, model_json, pathrisk


MONDAY = 1793577600  # 2026-11-02 00:00 UTC, a Monday


def commit(sha, time, files, reverts=None):
    return {"sha": sha, "time": time, "files": files, "reverts": reverts}


def history(*commits):
    return pathrisk.History.of(list(commits))


class TestLookup(TestCase):
    def test_node_order(self):
        self.assertEqual(model_json.path_nodes("a/b/c.py"), ["a/b/c.py", "a/b/", "a/"])
        self.assertEqual(model_json.path_nodes("setup.py"), ["setup.py"])
        long = "a/" + "x" * 600 + "/y.py"
        self.assertEqual(model_json.path_nodes(long), ["a/"])

    def test_node_order_matches_the_prefix_rule(self):
        for path in ("a/b/c.py", "a//b", "a/b/", "/a", "x", "a/" * 300 + "f.py"):
            parts = path.split("/")
            prefixes = ["/".join(parts[:i]) + "/" for i in range(len(parts) - 1, 0, -1)]
            want = [n for n in [path, *prefixes] if len(n) <= 512]
            self.assertEqual(model_json.path_nodes(path), want, path)

    def test_deep_long_path_is_linear(self):
        path = "/".join(["d" * 49] * 2000) + "/f.py"
        self.assertGreater(len(path), 100_000)
        began = time.perf_counter()
        nodes = model_json.path_nodes(path)
        self.assertLess(time.perf_counter() - began, 0.5)
        self.assertEqual(nodes, [("d" * 49 + "/") * k for k in range(10, 0, -1)])
        paths = {"base": 0.1, "nodes": {nodes[3]: 0.3}}
        self.assertEqual(model_json.file_rate(paths, path), 0.3)

    def test_lookup(self):
        paths = {"base": 0.1, "nodes": {"a/": 0.2, "a/b/": 0.3, "a/b/c.py": 0.4}}
        for f, want in (
            ("a/b/c.py", 0.4),
            ("a/b/d.py", 0.3),
            ("a/e.py", 0.2),
            ("z/c.py", 0.1),
            ("c.py", 0.1),
        ):
            self.assertEqual(model_json.file_rate(paths, f), want, f)
        got = model_json.path_values(paths, ["a/e.py", "a/b/c.py", "a/b/c.py"])
        self.assertAlmostEqual(got["path_revert_max"], math.log(0.4))
        self.assertAlmostEqual(got["path_revert_mean"], math.log(0.3))
        zero = model_json.path_values({"base": 0.0, "nodes": {}}, ["x.py"])
        self.assertEqual(zero["path_revert_max"], math.log(model_json.RATE_FLOOR))
        self.assertTrue(
            math.isnan(model_json.path_values(paths, [])["path_revert_max"])
        )

    def test_at_most_the_first_files(self):
        paths = {"base": 0.1, "nodes": {"z/": 0.9}}
        files = [f"a/{i:05d}.py" for i in range(model_json.MAX_CHANGED_FILES)]
        got = model_json.path_values(paths, [*files, "z/last.py"])
        self.assertAlmostEqual(got["path_revert_max"], math.log(0.1))
        got = model_json.path_values(paths, [*files[1:], "z/last.py"])
        self.assertAlmostEqual(got["path_revert_max"], math.log(0.9))


class TestTable(TestCase):
    def setUp(self):
        patcher = mock.patch.object(pathrisk, "MIN_TOUCHES", 1)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_shrinkage_hand_case(self):
        t = MONDAY - 30 * DAY
        h = history(
            commit("c1", t, ["a/x.py", "a/y.py"]),
            commit("c2", t + 1, ["a/x.py"]),
            commit("c3", t + 2, ["b.py"]),
            commit("c4", t + 3, ["a/y.py"]),
            commit("r1", t + 4, ["a/x.py"], reverts="c2"),
        )
        got = pathrisk.table(h, MONDAY)
        base = 1 / 4
        a = (1 + 20 * base) / (3 + 20)
        want = {
            "a/": a,
            "a/x.py": (1 + 20 * a) / (2 + 20),
            "a/y.py": (0 + 20 * a) / (2 + 20),
            "b.py": (0 + 20 * base) / (1 + 20),
        }
        self.assertEqual(got["base"], base)
        self.assertEqual(list(got["nodes"]), sorted(want))
        for k, v in want.items():
            self.assertAlmostEqual(got["nodes"][k], v, places=12, msg=k)
        self.assertEqual(pathrisk.table(history(), MONDAY), {"base": 0.0, "nodes": {}})

    def test_no_unit_sees_its_own_or_a_later_revert(self):
        h = history(
            commit("old", MONDAY - 10 * DAY, ["a/x.py"]),
            commit("own", MONDAY - 2 * DAY, ["a/x.py"]),
            commit("r_own", MONDAY - DAY, ["a/x.py"], reverts="own"),
            commit("r_old", MONDAY + DAY, ["a/x.py"], reverts="old"),
        )
        got = pathrisk.table(h, MONDAY)
        self.assertEqual(got["base"], 0.0)
        self.assertEqual(got["nodes"]["a/x.py"], 0.0)
        (values,) = pathrisk.unit_values(h, [(MONDAY + 2 * DAY, ["a/x.py"])])
        self.assertEqual(values, model_json.path_values(got, ["a/x.py"]))
        later = pathrisk.table(h, MONDAY + 7 * DAY)
        self.assertEqual(later["base"], 1.0)
        self.assertGreater(later["nodes"]["a/x.py"], 0.0)

    def test_window(self):
        h = history(
            commit("too_old", MONDAY - 366 * DAY, ["a.py"]),
            commit("first", MONDAY - 365 * DAY, ["b.py"]),
            commit("settling", MONDAY - 3 * DAY, ["c.py"]),
        )
        self.assertEqual(list(pathrisk.table(h, MONDAY)["nodes"]), ["b.py"])

    def test_week_start(self):
        self.assertEqual(pathrisk.week_start(MONDAY), MONDAY)
        self.assertEqual(pathrisk.week_start(MONDAY + 7 * DAY - 1), MONDAY)
        self.assertEqual(pathrisk.week_start(MONDAY - 1), MONDAY - 7 * DAY)

    def test_dropped_keys(self):
        digits = "1" * 15
        h = history(
            commit("c1", MONDAY - 9 * DAY, ["a/x.py", f"a/{digits}/y.py", "a/\tz.py"]),
            commit("c2", MONDAY - 8 * DAY, ["a/" + "w" * 600 + ".py"]),
        )
        nodes = pathrisk.table(h, MONDAY)["nodes"]
        self.assertEqual(list(nodes), ["a/", "a/x.py"])
        paths = pathrisk.table(h, MONDAY)
        self.assertEqual(model_json.file_rate(paths, f"a/{digits}/y.py"), nodes["a/"])
        self.assertIsNone(model_json.paths_problem(paths))


class TestPruning(TestCase):
    def test_pruned_alike_for_training_and_serving(self):
        commits = [
            commit(f"c{i}", MONDAY - (40 - i) * DAY, ["a/hot.py", f"a/cold{i % 9}.py"])
            for i in range(30)
        ]
        commits.append(commit("r", MONDAY - 5 * DAY, ["a/hot.py"], reverts="c3"))
        h = history(*commits)
        served = pathrisk.table(h, MONDAY)
        self.assertEqual(list(served["nodes"]), ["a/", "a/hot.py"])
        cutoff = MONDAY + 3 * DAY
        files = ["a/hot.py", "a/cold1.py"]
        (values,) = pathrisk.unit_values(h, [(cutoff, files)])
        self.assertEqual(values, model_json.path_values(served, files))
        with mock.patch.object(pathrisk, "table", wraps=pathrisk.table) as table:
            pathrisk.unit_values(h, [(cutoff, files), (cutoff + DAY, files)])
        self.assertEqual(table.call_count, 1)


def git(repo, *args, date=None):
    env = {"GIT_COMMITTER_DATE": f"@{date}", "GIT_AUTHOR_DATE": f"@{date}"}
    cmd = ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", *args]
    return subprocess.run(
        cmd, capture_output=True, text=True, check=True, env=env if date else None
    ).stdout.strip()


class TestMainHistory(TestCase):
    def test_main_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            t = MONDAY - 30 * DAY
            git(repo, "init", "-q", "-b", "main")
            (repo / "a").mkdir()
            (repo / "a" / "f.py").write_text("x\n")
            git(repo, "add", ".")
            git(repo, "commit", "-qm", "first", date=t)
            (repo / "a" / "f.py").write_text("x\ny\n")
            git(repo, "commit", "-qam", "second", date=t + 100)
            second = git(repo, "rev-parse", "HEAD")
            (repo / "a" / "f.py").write_text("x\n")
            git(
                repo,
                "commit",
                "-qam",
                f'Revert "second"\n\nThis reverts commit {second}.',
                date=t + 200,
            )
            revert = git(repo, "rev-parse", "HEAD")
            git(repo, "mv", "a/f.py", "a/g.py")
            git(
                repo,
                "commit",
                "-qm",
                f"Rename f\n\nThis reverts commit {second}, quoted.",
                date=t + 300,
            )
            (repo / "b.txt").write_text("b\n")
            git(repo, "add", ".")
            git(
                repo,
                "commit",
                "-qm",
                f"Back out x\n\nThis reverts commit {'f' * 40}.",
                date=t + 400,
            )
            got = gitdata.main_history(repo, t + 100)
            self.assertEqual(
                [c["time"] for c in got], [t + 100, t + 200, t + 300, t + 400]
            )
            self.assertEqual(got[0]["sha"], second)
            self.assertEqual([c["reverts"] for c in got], [None, second, None, None])
            self.assertEqual(got[1]["sha"], revert)
            self.assertEqual(got[2]["files"], ["a/g.py"])
            self.assertEqual(got[3]["files"], ["b.txt"])
            self.assertEqual(len(gitdata.main_history(repo, 0)), 5)
            h = pathrisk.History.of(got)
            self.assertEqual(
                [c.reverted_at for c in h.changes], [t + 200, None, None, None]
            )
            self.assertEqual(
                [c.is_revert for c in h.changes], [False, True, False, False]
            )
            with mock.patch.object(pathrisk.gitdata, "main_history") as mh:
                pathrisk.History.load(repo, MONDAY)
            mh.assert_called_once_with(repo, MONDAY - 372 * DAY)

    def test_parse_numstat_skips_forged_keys(self):
        sha = "a" * 40
        out = f"\x01{sha}\0\n1\t0\tx\x01not a sha\0\n5\t5\tforged.py\0"
        got = gitdata.parse_numstat(out)
        self.assertEqual(list(got), [sha])
        self.assertEqual(got[sha]["files"], ["x"])

    def test_reverted_sha(self):
        sha = "a" * 40
        msg = f"This reverts commit {sha}."
        self.assertEqual(gitdata.reverted_sha(f'Revert "x"\n\n{msg}'), sha)
        self.assertEqual(gitdata.reverted_sha(f"Back out D1\n\n{msg}"), sha)
        self.assertIsNone(gitdata.reverted_sha(f"Fix\n\n{msg}"))
        self.assertIsNone(gitdata.reverted_sha("Revert x\n\nno sha"))
        two = f"Revert y\n\nThis reverts commit {'b' * 40}.\n{msg}"
        self.assertEqual(gitdata.reverted_sha(two), "b" * 40)


if __name__ == "__main__":
    main()
