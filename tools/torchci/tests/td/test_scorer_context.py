import gzip
import json
import math
import subprocess
import tempfile
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from unittest import main, mock, TestCase

from torchci.td.historical_file_failure_correlation import FAILED_TESTS_QUERY
from torchci.td.labels import (
    CANDIDATES_FILE,
    main_units,
    queries as label_queries,
    UNITS_FILE,
)
from torchci.td.labels.schema import epoch
from torchci.td.llm import pytorch_repo
from torchci.td.scorer import context, gitdata, history, queries


H1, H2, H3, H4 = "1" * 40, "2" * 40, "3" * 40, "4" * 40
START, STOP = datetime(2026, 11, 1), datetime(2026, 11, 8)
T0 = epoch(START)
DAY = 86400


def unit(kind, sha, time, **kw):
    prefix = "c:" if kind == "main" else "p:7:"
    u = {"unit_id": prefix + sha, "kind": kind, "sha": sha, "time": time}
    u |= {"pr_number": 7, "positives": [], "candidates": None, "observed": None}
    u |= {"workflow": None if kind == "main" else "trunk", "train_ok": True}
    return {**u, **kw}


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", *args],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def commit(repo, files, message):
    for path, text in files.items():
        (repo / path).parent.mkdir(parents=True, exist_ok=True)
        (repo / path).write_text(text)
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", message)
    return git(repo, "rev-parse", "HEAD").strip()


class TestQueries(TestCase):
    def test_bound_parameters_and_read_only(self):
        for sql, params in (
            (queries.FAIL_HISTORY, ("{start: DateTime}", "{stop: DateTime}")),
            (queries.MERGE_BASES, ("{shas: Array(String)}",)),
            (queries.PR_META, ("{numbers: Array(Int64)}",)),
            (queries.ISSUE_TEXT, ("{numbers: Array(Int64)}",)),
            (queries.HEAD_RUNS, ("{shas: Array(String)}",)),
            (queries.PR_FAILURES, ("{start: DateTime64(3)}", "{cached: Array")),
        ):
            self.assertIn("readonly = 2", sql)
            self.assertIn("max_result_rows", sql)
            for p in params:
                self.assertIn(p, sql)

    def test_fail_history_is_the_generator_query_with_a_window(self):
        for part in (
            "metric_name = 'td_test_failure_stats_v2'",
            "JSONExtractString(info, 'failure')",
            "toUnixTimestamp(min(",
            "id in (select run_id from metrics)",
        ):
            self.assertIn(part.lower(), FAILED_TESTS_QUERY.lower())
            self.assertIn(part.lower(), queries.FAIL_HISTORY.lower())
        self.assertNotIn("now()", queries.FAIL_HISTORY.lower())
        self.assertNotIn("current_timestamp", queries.FAIL_HISTORY.lower())


class TestGit(TestCase):
    def test_parse_numstat(self):
        out = (
            f"\x01{H1}\0\n3\t1\ttorch/a.py\0-\t-\tdocs/img.png\0"
            "4\t2\t\0torch/old.py\0torch/new.py\0"
            "9\t9\ttest/test_a.py\0" + "5\t0\tREADME.md\0"
            f"\x01{H2}\0\n1\t0\tc10/x.h\0"
        )
        got = gitdata.parse_numstat(out)
        self.assertEqual(
            got[H1]["files"],
            [
                "torch/a.py",
                "docs/img.png",
                "torch/new.py",
                "test/test_a.py",
                "README.md",
            ],
        )
        self.assertEqual((got[H1]["sig_added"], got[H1]["sig_deleted"]), (7, 3))
        self.assertEqual(
            got[H2], {"files": ["c10/x.h"], "sig_added": 1, "sig_deleted": 0}
        )

    def test_main_commits_from_a_clone(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git(repo, "init", "-q", "-b", "main")
            lines = "".join(f"line {i}\n" for i in range(40))
            commit(repo, {"torch/old.py": lines, "README.md": "a\n"}, "first")
            git(repo, "mv", "torch/old.py", "torch/new.py")
            (repo / "blob.bin").write_bytes(bytes(range(256)))
            files = {"torch/new.py": lines + "more\n", "README.md": "a\nb\n"}
            sha = commit(repo, files, "second test_foo\n\nFixes #5")
            got = gitdata.main_commits(repo, [sha, H3, "not-a-sha"])
        self.assertEqual(list(got), [sha])
        self.assertEqual(
            sorted(got[sha]["files"]), ["README.md", "blob.bin", "torch/new.py"]
        )
        self.assertEqual((got[sha]["sig_added"], got[sha]["sig_deleted"]), (1, 0))
        self.assertIn("Fixes #5", got[sha]["message"])


class PrRepo(TestCase):
    """main: c0 - c1; a ghstack-like base branch c0 - b1; the PR head b1 - h."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        repo = self.repo = Path(self.tmp.name)
        git(repo, "init", "-q", "-b", "main")
        self.c0 = commit(repo, {"torch/a.py": "a\n"}, "c0")
        git(repo, "checkout", "-q", "-b", "base")
        self.b1 = commit(repo, {"torch/below.py": "x\n"}, "b1 below test_b")
        self.h = commit(repo, {"torch/a.py": "a2\n"}, "h touches test_h")
        git(repo, "checkout", "-q", "main")
        self.c1 = commit(repo, {"c10/x.h": "x\n"}, "c1")
        git(repo, "tag", "main", self.c0)

    def tearDown(self):
        self.tmp.cleanup()


class TestPrBases(PrRepo):
    def test_merge_base_with_the_pr_base_else_main(self):
        units = [
            unit("pr_td_off", self.h, T0, pr_number=1, unit_id="a"),
            unit("pr_td_off", self.h, T0, pr_number=2, unit_id="b"),
            unit("pr_td_off", H4, T0, pr_number=1, unit_id="c"),
            unit("main", self.c1, T0, unit_id="m"),
        ]
        meta = {1: {"base_sha": self.b1}, 2: {"base_sha": H3}}
        dropped = Counter()
        got = context.pr_bases(units, self.repo, meta, dropped)
        self.assertEqual(got, {"a": self.b1, "b": self.c0})
        self.assertEqual(
            dropped,
            Counter({"pr_td_off:no_head": 1, "pr_td_off:base_main_fallback": 1}),
        )

    def test_main_is_the_branch_not_a_tag(self):
        self.assertEqual(gitdata.main_ref(self.repo), self.c1)

    def test_unrelated_base_falls_back_to_main_else_drops(self):
        git(self.repo, "checkout", "-q", "--orphan", "lone")
        lone = commit(self.repo, {"other.py": "o\n"}, "lone")
        units = [unit("pr_td_off", self.h, T0, pr_number=1, unit_id="a")]
        meta = {1: {"base_sha": lone}}
        dropped = Counter()
        self.assertEqual(
            context.pr_bases(units, self.repo, meta, dropped), {"a": self.c0}
        )
        self.assertEqual(dropped, Counter({"pr_td_off:base_main_fallback": 1}))
        git(self.repo, "branch", "-q", "-m", "main", "trunk")
        git(self.repo, "tag", "-d", "main")
        dropped = Counter()
        self.assertEqual(context.pr_bases(units, self.repo, meta, dropped), {})
        self.assertEqual(dropped, Counter({"pr_td_off:no_base": 1}))

    def test_git_timeout_is_no_merge_base(self):
        timeout = subprocess.TimeoutExpired(["git"], 600)
        with mock.patch.object(pytorch_repo, "git", side_effect=timeout):
            self.assertIsNone(gitdata.merge_base(self.repo, self.b1, self.h))

    def test_failed_pr_diff_drops_the_unit(self):
        meta = {"number": 7, "body": "", "base_sha": self.b1, "base_ref": "b"}
        rows = {"pr_meta": [meta]}
        timeout = subprocess.TimeoutExpired(["git"], 600)
        with mock.patch.object(
            label_queries, "ch", lambda name, sql, params: rows.get(name, [])
        ), mock.patch.object(gitdata, "pr_change", side_effect=timeout):
            ctx = context.build(
                [unit("pr_td_off", self.h, T0, candidates=["test_p"], observed=[])],
                {"2026-11": ["test_p"]},
                self.repo,
                START,
                STOP,
            )
        self.assertEqual(ctx.units, {})
        self.assertEqual(ctx.dropped, Counter({"pr_td_off:no_diff": 1}))

    def test_failed_pr_numstat_is_nan(self):
        meta = {"number": 7, "body": "", "base_sha": self.b1, "base_ref": "b"}
        rows = {"pr_meta": [meta]}
        timeout = subprocess.TimeoutExpired(["git"], 600)
        with mock.patch.object(
            label_queries, "ch", lambda name, sql, params: rows.get(name, [])
        ), mock.patch.object(gitdata, "diff_numstat", side_effect=timeout):
            ctx = context.build(
                [unit("pr_td_off", self.h, T0, candidates=["test_p"], observed=[])],
                {"2026-11": ["test_p"]},
                self.repo,
                START,
                STOP,
            )
        (p,) = ctx.units.values()
        self.assertEqual(p["changed"], ["torch/a.py"])
        self.assertTrue(math.isnan(p["sig_added"]) and math.isnan(p["sig_deleted"]))

    def test_one_numstat_per_head(self):
        meta = {"number": 7, "body": "", "base_sha": self.b1, "base_ref": "b"}
        rows = {"pr_meta": [meta]}
        units = [
            unit("pr_td_off", self.h, T0, candidates=["test_p"], observed=[])
            | {"unit_id": f"p:7:{self.h}:{w}", "workflow": w}
            for w in ("pull", "trunk")
        ]
        with mock.patch.object(
            label_queries, "ch", lambda name, sql, params: rows.get(name, [])
        ), mock.patch.object(
            gitdata, "diff_numstat", wraps=gitdata.diff_numstat
        ) as numstat:
            ctx = context.build(units, {"2026-11": ["test_p"]}, self.repo, START, STOP)
        numstat.assert_called_once_with(self.repo, self.b1, self.h)
        self.assertEqual(len(ctx.units), 2)
        for c in ctx.units.values():
            self.assertEqual((c["sig_added"], c["sig_deleted"]), (1.0, 1.0))

    def test_diff_numstat(self):
        git(self.repo, "checkout", "-q", self.b1)
        head = commit(
            self.repo,
            {"torch/below.py": "x\ny\n", "test/t.py": "t\n", "docs/d.md": "d\n"},
            "edit",
        )
        got = gitdata.diff_numstat(self.repo, self.b1, head)
        self.assertEqual(
            sorted(got["files"]), ["docs/d.md", "test/t.py", "torch/below.py"]
        )
        self.assertEqual((got["sig_added"], got["sig_deleted"]), (1, 0))

    def test_pr_change_is_the_pr_only(self):
        changed, log = gitdata.pr_change(self.repo, self.b1, self.h)
        self.assertEqual(changed, ["torch/a.py"])
        self.assertIn("touches test_h", log)
        self.assertNotIn("below test_b", log)
        self.assertIn(f"commit {self.h}", log)

    def test_needed_and_fetched_commits(self):
        units = [unit("pr_td_off", H1, T0), unit("main", H2, T0)]
        shas = context.needed_commits(units, {7: {"base_sha": H3}})
        self.assertEqual(shas, [H1, H2, H3])
        with mock.patch.object(
            pytorch_repo, "fetch_missing", return_value=({H3}, 2)
        ) as fetch:
            self.assertEqual(context.fetch_commits(self.repo, shas + ["x"]), {H3})
        fetch.assert_called_once_with(self.repo, {H1, H2, H3})


class TestMentions(TestCase):
    def test_links_and_substrings(self):
        text = "see #12 and https://github.com/pytorch/pytorch/issues/34 ok #12"
        self.assertEqual(context.linked_numbers(text), [12, 34])
        many = " ".join(f"#{i}" for i in range(80))
        self.assertEqual(context.linked_numbers(many), list(range(context.MAX_LINKS)))
        tests = ["test_nn", "test_nn_utils", "inductor/test_x"]
        self.assertEqual(
            context.mentioned_tests("breaks test_nn_utils", tests),
            ["test_nn", "test_nn_utils"],
        )

    def test_bodies_followed_one_level(self):
        bodies = {
            "issue_text": [{"number": 5, "body": "test_b fails, see #9"}],
            "pr_meta": [{"number": 9, "body": "test_c"}, {"number": 5, "body": "x"}],
        }
        with mock.patch.object(
            label_queries, "ch", lambda name, sql, params: bodies[name]
        ):
            got = context.mentions(
                {"u": "test_a, fixes #5", "v": "nothing"},
                {"u": ["test_a", "test_b", "test_c"], "v": ["test_a"]},
            )
        self.assertEqual(got, {"u": ["test_a", "test_b"], "v": []})

    def test_pr_meta(self):
        rows = [{"number": "7", "body": None, "base_sha": H1, "base_ref": "main"}]
        with mock.patch.object(label_queries, "ch", return_value=rows) as ch:
            got = context.fetch_pr_meta(
                [unit("pr_td_off", H2, T0), unit("main", H3, T0, pr_number=8)]
            )
        self.assertEqual(got, {7: {"body": "", "base_sha": H1, "base_ref": "main"}})
        self.assertEqual(ch.call_args[0][2], {"numbers": [7]})


class TestPrFailures(TestCase):
    def test_prev_failed_by_workflow_before_cutoff(self):
        failures = [
            (90, "trunk", "test_a"),
            (95, "pull", "test_b"),
            (100, "trunk", "test_c"),
        ]
        self.assertEqual(history.prev_failed(failures, "trunk", 100), ["test_a"])
        self.assertEqual(history.prev_failed(failures, None, 100), ["test_a", "test_b"])

    def test_cutoff_is_the_last_run_start_by_the_unit_time(self):
        starts = {(H1, "trunk"): [100, 500, 900], (H1, "pull"): [550]}
        self.assertEqual(history.pr_cutoff(unit("pr_td_off", H1, 600), starts), 500)
        self.assertEqual(history.pr_cutoff(unit("pr_td_off", H2, 600), starts), 600)

    def test_every_failure_in_chunks(self):
        seen = []

        def ch(name, sql, params):
            seen.append(params)
            row = {"pr": "7", "workflow": "trunk", "head_sha": H2, "test_file": "t"}
            return [
                {**row, "ts": str(T0 - len(seen))},
                {**row, "head_sha": H3, "ts": "5"},
            ]

        with mock.patch.object(label_queries, "ch", ch):
            got = history.pr_failures(START, STOP)
        first = START - timedelta(days=history.PREV_FAILED_DAYS)
        self.assertEqual(seen[0]["start"], first.strftime("%Y-%m-%d %H:%M:%S"))
        self.assertEqual(seen[-1]["stop"], STOP.strftime("%Y-%m-%d %H:%M:%S"))
        self.assertEqual(seen[0]["cached"], ["win-", "tpu"])
        self.assertEqual(got, {7: [(T0 - len(seen), "trunk", "t"), (5, "trunk", "t")]})


class TestHistory(TestCase):
    def test_chunks_cover_the_generator_window(self):
        seen = []

        def ch(name, sql, params):
            seen.append((params["start"], params["stop"]))
            ts = 1000 + len(seen)
            return [{"head_sha": H1, "failure": "test_a", "ts": str(ts)}]

        with mock.patch.object(label_queries, "ch", ch):
            got = history.fetch_history(START, STOP)
        first = START - timedelta(days=history.HISTORY_DAYS)
        self.assertEqual(seen[0][0], first.strftime("%Y-%m-%d %H:%M:%S"))
        self.assertEqual(seen[-1][1], STOP.strftime("%Y-%m-%d %H:%M:%S"))
        self.assertTrue(all(a[1] == b[0] for a, b in zip(seen, seen[1:])))
        self.assertEqual(got, [{"head_sha": H1, "failure": "test_a", "ts": 1001}])

    def test_coverage(self):
        span = history.COVERAGE_DAYS * DAY
        self.assertTrue(history.covered(T0, T0 + span))
        self.assertFalse(history.covered(T0, T0 + span - 1))
        self.assertFalse(history.covered(None, T0 + 10 * span))


class TestFresh(TestCase):
    def test_window(self):
        t, span = 100 * DAY, history.FRESH_DAYS * DAY
        fails = {"a": [t - span], "b": [t - span - 1], "c": [t], "d": [t - 5, t + 9]}
        self.assertEqual(
            history.fresh(["a", "b", "c", "d", "e"], t, fails), ["b", "c", "e"]
        )

    def test_main_failure_times(self):
        pushes = [
            {"push_sha": "p1", "pushed_at": 50},
            {"push_sha": "p2", "pushed_at": 70},
        ]
        fail = [
            {"push_sha": "p2", "file": "test_a"},
            {"push_sha": "p1", "file": "test_a"},
        ]
        with mock.patch.object(
            main_units, "fetch_pushes", return_value=pushes
        ) as fp, mock.patch.object(
            main_units, "fetch_failures", return_value=([], fail)
        ):
            got = history.main_failure_times([20 * DAY, 21 * DAY])
        self.assertEqual(fp.call_count, 1)
        self.assertEqual(got, {"test_a": [50, 70]})


class TestBuild(PrRepo):
    def test_units(self):
        commits = {H1: {"files": ["torch/a.py"], "sig_added": 3, "sig_deleted": 1}}
        commits[H1]["message"] = "Fix test_m (#8)\n\nPull Request resolved: #44"
        rows = {
            "head_runs": [
                {
                    "head_sha": self.h,
                    "workflow": "trunk",
                    "run_id": 1,
                    "started": T0 + 50,
                }
            ],
            "fail_history": [{"head_sha": H2, "failure": "test_h", "ts": T0 - 9}],
            "merge_bases": [{"sha": H2, "merge_base": H1, "changed_files": ["x.py"]}],
            "issue_text": [],
            "pr_meta": [
                {
                    "number": 7,
                    "body": "touches test_p",
                    "base_sha": self.b1,
                    "base_ref": "b",
                },
                {"number": 44, "body": "test_l", "base_sha": "", "base_ref": ""},
            ],
            "pr_failures": [
                {
                    "pr": 7,
                    "workflow": "trunk",
                    "head_sha": H2,
                    "test_file": "test_e",
                    "ts": T0 + 10,
                },
                {
                    "pr": 7,
                    "workflow": "pull",
                    "head_sha": H2,
                    "test_file": "test_pull",
                    "ts": T0 + 10,
                },
                {
                    "pr": 7,
                    "workflow": "trunk",
                    "head_sha": H4,
                    "test_file": "test_late",
                    "ts": T0 + 60,
                },
                {
                    "pr": 8,
                    "workflow": "pull",
                    "head_sha": H2,
                    "test_file": "test_e8",
                    "ts": T0 + 10,
                },
                {
                    "pr": 8,
                    "workflow": "pull",
                    "head_sha": H4,
                    "test_file": "test_after",
                    "ts": T0 + 150,
                },
            ],
        }
        main_fails = {"test_m": [T0 + 100 - DAY], "test_n": [T0 - 20 * DAY]}
        months = {
            "2026-11": ["test_m", "test_n", "test_p", "test_e", "test_l", "test_h"]
        }
        units = [
            unit("main", H1, T0 + 100, pr_number=8, positives=["test_m", "test_n"]),
            unit("main", H2, T0 + 200),
            unit("pr_td_off", self.h, T0 + 300, candidates=["test_p"], observed=[]),
            unit("pr_td_off", H4, T0 + 400, candidates=["test_p"], observed=[]),
        ]

        def ch(name, sql, params):
            return (
                rows[name]
                if name != "pr_failures" or params["start"] < "2026-10"
                else []
            )

        with mock.patch.object(
            gitdata, "main_commits", return_value=commits
        ), mock.patch.object(label_queries, "ch", ch), mock.patch.object(
            history, "main_failure_times", return_value=main_fails
        ):
            ctx = context.build(units, months, self.repo, START, STOP)
        self.assertEqual(
            ctx.dropped, Counter({"main:no_commit": 1, "pr_td_off:no_head": 1})
        )
        self.assertEqual(sorted(ctx.units), ["c:" + H1, "p:7:" + self.h])
        m, p = ctx.units["c:" + H1], ctx.units["p:7:" + self.h]
        self.assertEqual(m["changed"], ["torch/a.py"])
        self.assertEqual((m["sig_added"], m["sig_deleted"]), (3.0, 1.0))
        self.assertEqual(m["mentioned"], ["test_l", "test_m"])
        self.assertEqual(m["prev_failed"], ["test_e8"])
        self.assertEqual(m["fresh"], ["test_n"])
        self.assertEqual(p["cutoff"], T0 + 50)
        self.assertEqual(p["changed"], ["torch/a.py"])
        self.assertEqual(p["prev_failed"], ["test_e"])
        self.assertEqual(p["mentioned"], ["test_h", "test_p"])
        self.assertEqual((p["sig_added"], p["sig_deleted"]), (1.0, 1.0))
        self.assertEqual(ctx.history, rows["fail_history"])
        self.assertEqual((ctx.history_start, ctx.pr_failures_start), (T0 - 9, T0 + 10))
        self.assertIn(H2, ctx.merge_bases)


class TestLabels(TestCase):
    def test_read_and_window(self):
        units = [
            unit("main", H1, T0, candidates_month="2026-11"),
            unit("pr_td_off", H2, epoch(STOP)),
            unit("explored", H3, T0 + 5),
            unit("pr_td_off", H4, T0 - 1),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            for name, rows in (
                (UNITS_FILE, units),
                (CANDIDATES_FILE, [{"month": "2026-11", "tests": ["a"]}]),
            ):
                with gzip.open(d / name, "wt") as f:
                    f.write("".join(json.dumps(r) + "\n" for r in rows))
            got, months = context.read_labels(d)
        self.assertEqual(months, {"2026-11": ["a"]})
        self.assertEqual(
            [u["sha"] for u in context.window_units(got, START, STOP)], [H1]
        )
        u = unit("pr_td_off", H2, T0, candidates=["b"])
        self.assertEqual(context.unit_tests(u, months), ["a", "b"])


if __name__ == "__main__":
    main()
