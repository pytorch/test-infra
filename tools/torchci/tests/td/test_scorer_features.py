import gzip
import json
import math
import subprocess
import sys
import tempfile
from collections import Counter
from datetime import datetime
from pathlib import Path
from unittest import main, mock, TestCase

import numpy as np
from torchci.td.labels.schema import epoch
from torchci.td.llm.replay import FileTimes
from torchci.td.scorer import context, features, gitdata, heuristics, spec
from torchci.td.scorer.context import Context
from torchci.td.utils import calculate_generic_test_ratings, HALF_LIFE_DAYS


FIXTURE = Path(__file__).parent / "fixtures" / "td_scorer_parity.json"
H1, H2, H3, H4, H5 = "1" * 40, "2" * 40, "3" * 40, "4" * 40, "5" * 40
DAY = 86400
T0 = epoch(datetime(2026, 11, 2))
FULL_FROM = datetime(2026, 11, 5)
HEURISTICS_DIR = "tools/testing/target_determination/heuristics"
# Stand-ins for pytorch's helpers with the same signatures; is_docs_only_change is
# pytorch's rule.
STUBS = {
    "tools/__init__.py": "",
    "tools/stats/__init__.py": "",
    "tools/testing/__init__.py": "",
    f"{HEURISTICS_DIR}/__init__.py": "",
    f"{HEURISTICS_DIR}/utils.py": """
import os
def python_test_file_to_test_name(tests):
    return {t[5:-3] for t in tests if t.startswith("test/") and t.endswith(".py")}
def is_docs_only_change(changed_files):
    if not changed_files:
        return False
    for f in changed_files:
        if f and os.path.splitext(f)[1].lower() not in (".rst", ".md"):
            return False
    return True
""",
    f"{HEURISTICS_DIR}/filepath.py": """
def get_freq_dict(tests, changed_files):
    freq = {}
    for f in changed_files:
        for k in f.split("/")[:-1]:
            freq[k] = freq.get(k, 0) + 1
    out = {}
    for t in tests:
        for k, n in freq.items():
            if k in t:
                out[t] = out.get(t, 0) + n
    return out
""",
    f"{HEURISTICS_DIR}/edited_by_pr.py": (
        'ADDITIONAL_MAPPINGS = {"test_cpp_extensions_aot": [r"test\\/cpp_extensions.*"]}\n'
    ),
}


def git(repo, *args):
    cmd = ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", *args]
    return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout


class Stubbed(TestCase):
    """Loads the stub helpers through heuristics.load_helpers from a git repo."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        repo = Path(cls.tmp.name) / "pytorch"
        for path, text in STUBS.items():
            (repo / path).parent.mkdir(parents=True, exist_ok=True)
            (repo / path).write_text(text)
        git(repo, "init", "-q", "-b", "main")
        git(repo, "add", ".")
        git(repo, "commit", "-q", "-m", "stubs")
        cls.repo, cls.cache = repo, Path(cls.tmp.name) / "cache"
        cls.h = heuristics.load_helpers(repo, cls.cache)

    @classmethod
    def tearDownClass(cls):
        for name in [m for m in sys.modules if m == "tools" or m.startswith("tools.")]:
            del sys.modules[name]
        sys.path[:] = [p for p in sys.path if not p.startswith(cls.tmp.name)]
        cls.tmp.cleanup()


class TestHeuristics(Stubbed):
    def test_fixture_stats_case(self):
        case = json.loads(FIXTURE.read_text())["stats_case"]
        self.assertEqual(
            heuristics.unit_stats(self.h, case["changed"]), case["expected"]
        )
        self.assertEqual(list(case["expected"]), list(spec.UNIT_STATS))
        docs = heuristics.unit_stats(self.h, case["docs_only_changed"])
        self.assertEqual(docs["docs_only"], case["docs_only_expected"])

    def test_fixture_numstat_case(self):
        case = json.loads(FIXTURE.read_text())["numstat_case"]
        out = f"\x01{H1}\0\n"
        for r in case["records"]:
            a, d = ("-" if r[k] is None else str(r[k]) for k in ("added", "deleted"))
            if r["old_path"]:
                out += f"{a}\t{d}\t\0{r['old_path']}\0{r['path']}\0"
            else:
                out += f"{a}\t{d}\t{r['path']}\0"
        got = gitdata.parse_numstat(out)[H1]
        want = case["expected"]
        self.assertEqual(float(got["sig_added"]), want["sig_added"])
        self.assertEqual(float(got["sig_deleted"]), want["sig_deleted"])
        stats = heuristics.unit_stats(self.h, got["files"])
        risk = heuristics.risk_inputs(stats, got["sig_added"], got["sig_deleted"])
        for f in ("log_sig_added", "log_sig_deleted"):
            self.assertAlmostEqual(risk[f], want[f], delta=1e-11)

    def test_helpers_need_a_main_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git(repo, "init", "-q", "-b", "trunk")
            git(repo, "commit", "-q", "--allow-empty", "-m", "x")
            git(repo, "tag", "main")
            with self.assertRaises(RuntimeError):
                heuristics.load_helpers(repo, repo / "cache")

    def test_helpers_load_once_from_the_clone(self):
        self.assertTrue((self.cache / "pytorch-tools").is_dir())
        self.assertIs(
            heuristics.load_helpers(self.repo, self.cache).get_freq_dict,
            self.h.get_freq_dict,
        )

    def test_edited_and_public_bindings(self):
        changed = ["test/test_a.py", "test/cpp_extensions/x.cpp", "torch/x.py"]
        tests = ["test_a", "test_cpp_extensions_aot", "test_public_bindings"]
        self.assertEqual(
            heuristics.edited(self.h, changed, tests),
            {"test_a", "test_cpp_extensions_aot"},
        )
        self.assertEqual(
            heuristics.public_bindings(changed, tests), {"test_public_bindings"}
        )
        self.assertEqual(heuristics.public_bindings(["c10/x.h"], tests), set())
        allowlist = ["test/allowlist_for_publicAPI.json"]
        self.assertEqual(
            heuristics.public_bindings(allowlist, tests), {"test_public_bindings"}
        )

    def test_sums_and_normalisation(self):
        ratings = {"a.py": {"t1": 1.0, "t2": 3.0, "t9": 8.0}, "b.py": {"t1": 1.0}}
        self.assertEqual(
            heuristics.sums(ratings, ["a.py", "b.py"], ["t1", "t2"]),
            {"t1": 2.0, "t2": 3.0},
        )
        self.assertEqual(
            heuristics.rating_served(ratings, ["a.py", "b.py"], ["t1", "t2"]),
            {"t1": 2 / 3 * 0.25, "t2": 0.25},
        )
        self.assertEqual(heuristics.normalize({"t1": 1.0, "t2": 0.0}, 0.25), {})

    def test_filepath(self):
        tests = ["inductor/test_a", "inductor/test_b_inductor", "test_c"]
        got = heuristics.filepath_served(
            self.h, ["torch/_inductor/x.py", "inductor/y.py"], tests
        )
        self.assertEqual(
            got, {"inductor/test_a": 0.1875, "inductor/test_b_inductor": 0.25}
        )
        docs = heuristics.filepath_served(self.h, ["README.md"], tests)
        self.assertEqual(docs, dict.fromkeys(tests, -1.0))
        self.assertEqual(heuristics.filepath_served(self.h, [], tests), {})

    def test_rebuild_fail_window_merge_base_and_own_head(self):
        day = T0
        bases = {
            H1: {"merge_base": H3, "changed_files": ["a.py"]},
            H2: {"merge_base": H3, "changed_files": ["a.py", "b.py"]},
            H3: {"merge_base": H4, "changed_files": ["c.py"]},
        }
        history = [
            {"head_sha": H1, "failure": "t1", "ts": day - DAY},
            {"head_sha": H2, "failure": "t1", "ts": day - 2 * DAY},
            {"head_sha": H2, "failure": "t2", "ts": day - 2 * DAY},
            {"head_sha": H3, "failure": "t2", "ts": day - 3 * DAY},
            {"head_sha": H1, "failure": "late", "ts": day},
            {"head_sha": H1, "failure": "old", "ts": day - 91 * DAY},
            {"head_sha": H4, "failure": "no_base", "ts": day - DAY},
        ]
        got = heuristics.rebuild_fail(history, bases, day)
        kept = [history[0], history[1], history[3]]
        want = calculate_generic_test_ratings(
            kept, bases, lambda x: x["failure"], HALF_LIFE_DAYS, now=day
        )
        self.assertEqual(set(got), {"a.py", "b.py", "c.py"})
        self.assertAlmostEqual(got["a.py"]["t1"], want["a.py"]["t1"], places=9)
        self.assertNotIn("t2", got["a.py"])
        own = heuristics.rebuild_fail(history, bases, day, exclude=H1)
        self.assertAlmostEqual(own["a.py"]["t1"], 0.5 * 0.5 ** (2 / 7), places=9)

    def test_risk_inputs(self):
        stats = heuristics.unit_stats(self.h, ["torch/a.py", "test/test_a.py"])
        got = heuristics.risk_inputs(stats, 10.0, math.nan)
        self.assertEqual(list(got), list(spec.RISK_INPUTS))
        self.assertEqual(got["log_files"], math.log1p(2))
        self.assertEqual(got["log_src_files"], math.log1p(1))
        self.assertEqual(got["log_sig_added"], math.log1p(10))
        self.assertTrue(math.isnan(got["log_sig_deleted"]))


def unit(kind, sha, time, **kw):
    u = {"unit_id": ("c:" if kind == "main" else "p:7:") + sha, "kind": kind}
    u |= {"sha": sha, "time": time, "pr_number": 7, "positives": [], "train_ok": True}
    u |= {"candidates_month": "2026-11" if kind == "main" else None}
    u |= {"candidates": None, "observed": None, "workflow": "trunk"}
    u |= {"build_environment": "macos", "test_config": "default"}
    return {**u, **kw}


MONTHS = {"2026-11": ["inductor/test_a", "test_b", "test_c", "test_d", "test_big"]}
TIMES = {
    "macos": {"default": {"test_b": 30.0, "test_c": 0.0}},
    "linux": {"x": {"test_b": 10.0, "test_d": 4.0}},
}
STATS = {
    "test-times": TIMES,
    "td_heuristic_historical_edited_files": {
        "torch/x.py": {"test_b": 2.0, "test_big": 4.0}
    },
    "td_heuristic_profiling": {"torch/x.py": {"test_c": 1.0}},
}


class TestUnitRules(TestCase):
    def test_labels(self):
        tests = ["a", "b", "c"]
        m = features.labels(unit("main", H1, T0, positives=["b"]), tests)
        np.testing.assert_array_equal(m, [0.0, 1.0, 0.0])
        p = features.labels(
            unit("pr_td_off", H1, T0, positives=["a"], observed=["a", "b"]), tests
        )
        np.testing.assert_array_equal(p, [1.0, 0.0, np.nan])

    def test_costs(self):
        times = FileTimes(TIMES)
        tests = ["test_b", "test_c", "test_d", "test_x"]
        pr = features.costs(unit("pr_td_off", H1, T0), tests, TIMES, times)
        np.testing.assert_array_equal(pr, [45.0, 15.0, 30.0, 30.0])
        main_ = features.costs(unit("main", H1, T0), tests, TIMES, times)
        np.testing.assert_array_equal(main_, [35.0, 15.0, 19.0, 19.0])
        none = features.costs(unit("main", H1, T0), ["test_x"], TIMES, times)
        self.assertTrue(np.isnan(none).all())

    def test_job_times_fall_back_like_run_test(self):
        tt = {
            "linux": {"default": {"a": 1.0}},
            "default": {"cfg": {"a": 2.0}, "default": {"a": 3.0}},
        }
        times = FileTimes(tt)
        for env, config, want in (
            ("linux", "default", 1.0),
            ("linux", "cfg", 2.0),
            ("other", "cfg", 2.0),
            ("other", "nope", 3.0),
        ):
            u = unit("pr_td_off", H1, T0, build_environment=env, test_config=config)
            self.assertEqual(features.job_times(u, tt, times)["a"], want)
        self.assertEqual(features.job_times(unit("main", H1, T0), tt, times)["a"], 2.0)

    def test_keep_is_stable(self):
        keys = [f"u{i}" for i in range(5000)]
        draws = [features.keep(k, 0.2) for k in keys]
        self.assertEqual(draws, [features.keep(k, 0.2) for k in keys])
        self.assertAlmostEqual(sum(draws) / len(draws), 0.2, delta=0.02)
        self.assertFalse(features.keep("x", 0.0))
        self.assertTrue(features.keep("x", 1.0))

    def test_selection(self):
        units = [unit("main", f"{i:040d}", T0) for i in range(200)]
        units += [
            unit("main", H1, T0, positives=["test_b"]),
            unit("main", H2, epoch(FULL_FROM)),
            unit("main", H3, T0, positives=["test_b"], train_ok=False),
            unit("pr_td_off", H1, T0, observed=None),
            unit("pr_td_off", H2, T0, observed=[]),
            unit("explored", H4, T0),
        ]
        got = {u["unit_id"] for u in features.selected_units(units, FULL_FROM)}
        self.assertEqual(
            got, {u["unit_id"] for u in features.selected_units(units, FULL_FROM)}
        )
        self.assertTrue({"c:" + H1, "c:" + H2, "p:7:" + H2} <= got)
        self.assertFalse({"c:" + H3, "p:7:" + H1, "p:7:" + H4} & got)
        sampled = sum(u["unit_id"] in got for u in units[:200])
        self.assertTrue(20 <= sampled <= 60, sampled)

    def test_weights(self):
        tests = [f"t{i}" for i in range(1000)]
        full_from = epoch(FULL_FROM)
        neg = unit("main", H1, T0)
        w = features.weights(neg, tests, np.zeros(1000), full_from)
        self.assertEqual(set(w), {0.0, 25.0})
        self.assertAlmostEqual((w > 0).mean(), 0.2, delta=0.04)
        np.testing.assert_array_equal(
            w, features.weights(neg, tests, np.zeros(1000), full_from)
        )
        pos = unit("main", H1, T0, positives=["t0"])
        y = np.zeros(1000)
        y[0] = 1.0
        w = features.weights(pos, tests, y, full_from)
        self.assertEqual(w[0], 1.0)
        self.assertEqual(set(w[1:]), {0.0, 5.0})
        pr = unit("pr_td_off", H1, T0, positives=["t0"])
        y[1:3] = math.nan
        w = features.weights(pr, tests, y, full_from)
        self.assertEqual((w[1], w[2]), (0.0, 0.0))
        np.testing.assert_array_equal(
            features.weights(neg, tests, y, T0), np.ones(1000)
        )

    def test_unit_weight_everywhere(self):
        full_from = epoch(FULL_FROM)
        cases = [(unit("main", f"{i:040d}", T0), 5.0) for i in range(100)] + [
            (unit("main", H1, T0, positives=["test_b"]), 1.0),
            (unit("main", H2, full_from), 1.0),
            (unit("pr_td_off", H3, T0, observed=[]), 1.0),
        ]
        for u, want in cases:
            self.assertEqual(features.unit_weight(u, full_from), want)
        units = [u for u, _ in cases]
        selected = features.selected_units(units, FULL_FROM)
        dropped = [u for u in units if u not in selected]
        self.assertTrue(dropped)
        self.assertTrue(all(features.unit_weight(u, full_from) == 5.0 for u in dropped))
        tests = [f"t{i}" for i in range(50)]
        for u in selected:
            w = features.weights(u, tests, np.zeros(50), full_from)
            unit_w = features.unit_weight(u, full_from)
            if int(u["time"]) < full_from:
                self.assertEqual(set(w) - {0.0}, {unit_w / features.NEG_KEEP})
        stats = {f: 0.0 for f in spec.UNIT_STATS} | {"n_files": 1.0}
        ctx = Context(
            {
                u["unit_id"]: {"stats": stats, "sig_added": 1.0, "sig_deleted": 0.0}
                for u in selected
            },
            [],
            {},
        )
        table = features.unit_table(selected, ctx, full_from)
        self.assertEqual(tuple(table.columns), spec.UNIT_COLUMNS)
        self.assertEqual(
            list(table["uw"]), [features.unit_weight(u, full_from) for u in selected]
        )
        self.assertEqual(set(table["uw"]), {1.0, 5.0})


class TestRows(Stubbed):
    def make(self):
        bases = {H4: {"merge_base": H3, "changed_files": ["torch/x.py"]}}
        bases[H2] = {"merge_base": H3, "changed_files": ["torch/x.py"]}
        bases[H5] = {"merge_base": H3, "changed_files": ["torch/x.py"]}
        history = [
            {"head_sha": H4, "failure": "test_big", "ts": T0 - DAY},
            {"head_sha": H4, "failure": "test_b", "ts": T0 - DAY},
            {"head_sha": H4, "failure": "test_c", "ts": T0 + 10},
            {"head_sha": H2, "failure": "test_d", "ts": T0 - DAY},
            {"head_sha": H5, "failure": "test_big", "ts": T0 - DAY},
        ]
        ctx = Context({}, history, bases, Counter({"pr_td_off:no_merge_base": 1}))
        ctx.history_start = ctx.pr_failures_start = T0 - 60 * DAY
        units = [
            unit("main", H1, T0 + 100, positives=["test_b"]),
            unit(
                "pr_td_off",
                H2,
                T0 + 200,
                candidates=["test_b", "test_c", "test_d"],
                positives=["test_b"],
                observed=["test_b", "test_c"],
            ),
            unit("main", H3, epoch(FULL_FROM) + 5),
            unit(
                "pr_td_off",
                H4,
                epoch(FULL_FROM) + 9,
                candidates=["test_b", "test_d"],
                positives=["test_b"],
                observed=["test_b"],
            ),
        ]
        for u, changed in zip(
            units, (["torch/x.py"], ["torch/x.py"], ["README.md"], ["torch/x.py"])
        ):
            ctx.units[u["unit_id"]] = {
                "cutoff": int(u["time"]) - 50,
                "changed": changed,
                "prev_failed": ["test_c"],
                "mentioned": ["test_d"],
                "sig_added": 4.0 if u["kind"] == "main" else math.nan,
                "sig_deleted": 0.0 if u["kind"] == "main" else math.nan,
                "fresh": ["test_b"] if u["kind"] == "main" else [],
            }
        return units, ctx

    def rows(self, procs=1, llm=None, starts=None):
        units, ctx = self.make()
        if starts is not None:
            ctx.history_start, ctx.pr_failures_start = starts
        with mock.patch.object(features, "NEG_KEEP", 1.0):
            return features.rows_for(
                units, MONTHS, ctx, self.h, STATS, FULL_FROM, llm, procs
            )

    def test_columns_types_and_units(self):
        rows, table = self.rows(llm={"c:" + H1: {"test_b": 0.25}})
        self.assertEqual(tuple(rows.columns), spec.ROW_COLUMNS)
        for f in features.FEATURES:
            self.assertEqual(rows[f].dtype, np.float64, f)
        self.assertEqual(tuple(table.columns), spec.UNIT_COLUMNS)
        self.assertEqual(table.attrs["dropped"], {"pr_td_off:no_merge_base": 1})
        self.assertEqual(list(table["n_positives"]), [1, 1, 0, 1])
        self.assertEqual(list(table["uw"]), [1.0, 1.0, 1.0, 1.0])
        self.assertTrue(table["log_sig_added"].iloc[1:2].isna().all())
        self.assertEqual(table["log_sig_added"].iloc[0], math.log1p(4.0))
        main_b = rows[(rows["unit_id"] == "c:" + H1) & (rows["test"] == "test_b")].iloc[
            0
        ]
        self.assertEqual((main_b["y"], main_b["w"], main_b["llm_n"]), (1.0, 1.0, 0.25))
        self.assertTrue(main_b["fresh"])
        self.assertEqual((main_b["prev_failed"], main_b["is_pr"]), (0.0, 0.0))
        self.assertEqual(main_b["test_seconds"], 20.0)
        self.assertEqual(
            rows.loc[rows["unit_id"] == "p:7:" + H2, "is_pr"].unique().tolist(), [1.0]
        )

    def test_month_list_normalisation_and_cutoff(self):
        rows, _ = self.rows()
        pr = rows[rows["unit_id"] == "p:7:" + H2].set_index("test")
        self.assertEqual(sorted(pr.index), ["test_b", "test_c"])
        # test_big is not a candidate but holds the month's largest rating.
        self.assertAlmostEqual(pr.loc["test_b", "fail_n"], 0.125, places=9)
        self.assertEqual(pr.loc["test_c", "fail_n"], 0.0)
        self.assertEqual(pr.loc["test_c", "prev_failed"], 1.0)
        self.assertEqual(pr.loc["test_c", "y"], 0.0)
        self.assertTrue(rows.loc[~rows["full"], list(spec.TD_ONLY)].isna().all().all())

    def test_uncovered_history_is_nan(self):
        starts = (T0 - 29 * DAY, T0 - 29 * DAY + 100)
        rows, _ = self.rows(starts=starts)
        early = rows["unit_id"].isin(["c:" + H1, "p:7:" + H2])
        self.assertTrue(rows.loc[early, ["fail_n", "prev_failed"]].isna().all().all())
        later = rows.loc[~early, ["fail_n", "prev_failed"]]
        self.assertFalse(later.isna().any().any())
        self.assertGreater(later["fail_n"].max(), 0.0)
        rows, _ = self.rows(starts=(None, None))
        self.assertTrue(rows[["fail_n", "prev_failed"]].isna().all().all())

    def test_own_head_excluded(self):
        rows, _ = self.rows()
        own = rows[rows["unit_id"] == "p:7:" + H4].set_index("test")
        self.assertEqual(own.loc["test_b", "fail_n"], 0.0)
        self.assertEqual(own.loc["test_d", "fail_n"], 0.25)

    def test_full_rows(self):
        rows, _ = self.rows()
        full = rows[rows["full"]]
        self.assertEqual(set(full["unit_id"]), {"c:" + H3, "p:7:" + H4})
        self.assertTrue((full["w"] == 1.0).all())
        docs = full[full["unit_id"] == "c:" + H3]
        self.assertEqual(sorted(docs["test"]), sorted(MONTHS["2026-11"]))
        self.assertTrue((docs["filepath_s"] == -1.0).all())
        self.assertTrue((docs["docs_only"] == 1.0).all())
        pr = full[full["unit_id"] == "p:7:" + H4].set_index("test")
        self.assertTrue(math.isnan(pr.loc["test_d", "y"]))
        self.assertEqual(pr.loc["test_b", "coedit_n"], 0.125)
        self.assertEqual(pr.loc["test_b", "profiling_n"], 0.0)
        self.assertEqual(pr.loc["test_b", "cost"], 45.0)

    def test_parallel_matches_serial(self):
        serial, _ = self.rows(procs=1)
        parallel, _ = self.rows(procs=2)
        self.assertTrue(serial.equals(parallel))


class TestBuild(TestCase):
    def test_llm_mapping_drops_absent_units(self):
        units = [
            unit("main", H1, T0, positives=["test_b"]),
            unit("main", H2, T0 + 1, positives=["test_b"]),
            unit("pr_td_off", H3, T0 + 2, candidates=["test_b"], observed=["test_b"]),
        ]
        seen = {}

        def fake_context(units, months, repo, start, stop):
            seen["units"] = [u["unit_id"] for u in units]
            return Context({}, [], {}, Counter())

        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            for name, rows in (
                (context.UNITS_FILE, units),
                (context.CANDIDATES_FILE, [{"month": "2026-11", "tests": ["test_b"]}]),
            ):
                with gzip.open(d / name, "wt") as f:
                    f.write("".join(json.dumps(r) + "\n" for r in rows))
            with mock.patch.object(heuristics, "load_helpers"), mock.patch.object(
                context, "build", fake_context
            ):
                args = (
                    d,
                    Path("/nonexistent"),
                    STATS,
                    datetime(2026, 11, 1),
                    datetime(2026, 11, 8),
                    FULL_FROM,
                )
                _, table = features.build(*args, llm={"c:" + H1: {}}, procs=1)
                self.assertEqual(seen["units"], ["c:" + H1])
                self.assertEqual(
                    table.attrs["dropped"], {"main:no_llm": 1, "pr_td_off:no_llm": 1}
                )
                features.build(*args, procs=1)
                self.assertEqual(len(seen["units"]), 3)


if __name__ == "__main__":
    main()
