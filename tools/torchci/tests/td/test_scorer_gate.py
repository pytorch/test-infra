import contextlib
import io
import json
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest import main, mock, TestCase

import numpy as np
import pandas as pd
from threadpoolctl import threadpool_limits
from torchci.td.labels.schema import DAY, epoch
from torchci.td.llm.replay import CUT_PERCENT
from torchci.td.scorer import (
    __main__ as cli,
    evaluate,
    gate,
    model_json,
    pathrisk,
    spec,
    train,
)


FIXTURE = Path(__file__).parent / "fixtures" / "td_scorer_parity.json"
CUTOFF = 1793491200  # 2026-11-01 00:00 UTC
NOW = "2026-11-04T13:00:00Z"
HISTORY = pathrisk.History.of(
    [
        {"sha": f"s{i}", "time": CUTOFF - (20 + i) * DAY, "files": ["torch/x.py"]}
        | {"reverts": "s9" if i == 0 else None}
        for i in range(10)
    ]
)


def get_top_per_tests(n_tests: int, percent: int = 25) -> int:
    """pytorch's TestPrioritizations.get_top_per_tests, as the count it keeps."""
    tests = list(range(n_tests))
    index = percent * len(tests) // 100 + 1
    return len(tests[:index])


def unit_rows(uid, kind, tests, td, p, y, cost=None, fresh=None, time=CUTOFF - DAY):
    n = len(tests)
    frame = pd.DataFrame(0.0, index=range(n), columns=list(spec.ROW_COLUMNS))
    return frame.assign(
        unit_id=uid,
        kind=kind,
        time=time,
        test=tests,
        y=y,
        w=1.0,
        fresh=fresh if fresh is not None else [True] * n,
        full=True,
        cost=cost or [20.0] * n,
        fail_n=td,
        pp=p,
    )


def synthetic(n_units: int = 300, n_tests: int = 30, days: int = 120, seed: int = 0):
    """Rows where fail_n drives the label; the last 56 days are full rows."""
    rng = np.random.default_rng(seed)
    rows, units = [], []
    for i in range(n_units):
        uid, t = f"u{i}", CUTOFF - days * DAY + i * days * DAY // n_units
        kind = "pr_td_off" if i % 3 == 0 else "main"
        x = rng.random((n_tests, len(spec.SCORER_FEATURES)))
        x[:, 0] *= 0.25
        fail = x[:, spec.SCORER_FEATURES.index("fail_n")]
        y = (rng.random(n_tests) < 1 / (1 + np.exp(5 - 24 * fail))).astype(float)
        if i % 4 == 1:
            y[:] = 0.0
        frame = pd.DataFrame(x, columns=list(spec.SCORER_FEATURES)).assign(
            unit_id=uid,
            kind=kind,
            time=t,
            test=[f"test_{j:02d}" for j in range(n_tests)],
            y=y,
            w=1.0,
            fresh=True,
            full=t >= CUTOFF - 56 * DAY,
            cost=15.0 + 100 * rng.random(n_tests),
            coedit_n=0.0,
            profiling_n=0.0,
        )
        rows.append(frame[list(spec.ROW_COLUMNS)])
        unit = {"unit_id": uid, "kind": kind, "time": t, "train_ok": True}
        unit["n_positives"] = int(y.sum())
        unit["uw"] = 5.0 if kind == "main" and not y.any() else 1.0
        unit.update({f: float(rng.random()) for f in spec.RISK_INPUTS})
        unit.update({f: float(-3 * rng.random()) for f in spec.PATH_FEATURES})
        units.append(unit)
    return pd.concat(rows, ignore_index=True), pd.DataFrame(units)


class TestCut(TestCase):
    def test_fixture_cut_case(self) -> None:
        case = json.loads(FIXTURE.read_text())["cut_case"]
        self.assertEqual(case["percent"], CUT_PERCENT)
        a, include = evaluate.matched_cut(case["td_order"], case["p"], case["cost"])
        self.assertEqual(a, case["expected_exponent"])
        self.assertEqual(include, case["expected_include"])

    def test_count_matches_get_top_per_tests(self) -> None:
        for n in (1, 3, 4, 7, 100, 1147):
            tests = [f"t{i:04d}" for i in range(n)]
            p = {t: 1.0 / (i + 1) for i, t in enumerate(tests)}
            _, include = evaluate.matched_cut(tests, p, {t: 10.0 for t in tests})
            self.assertEqual(len(include), get_top_per_tests(n))
            self.assertEqual(evaluate.cut_count(n), get_top_per_tests(n))

    def test_ties_and_fallback(self) -> None:
        tests = ["b", "a", "c", "d", "e"]
        p = {t: 0.1 for t in tests}
        self.assertEqual(
            evaluate.matched_cut(tests, p, {t: 1.0 for t in tests}), (0.0, ["a", "b"])
        )
        cost = {"b": 10.0, "a": 10.0, "c": 100.0, "d": 100.0, "e": 100.0}
        p = {"b": 0.001, "a": 0.001, "c": 0.5, "d": 0.4, "e": 0.3}
        self.assertEqual(evaluate.matched_cut(tests, p, cost), (None, ["b", "a"]))
        self.assertEqual(evaluate.matched_cut([], {}, {}), (None, []))
        cost = {t: float("nan") for t in tests}
        self.assertEqual(evaluate.matched_cut(tests, p, cost), (None, ["b", "a"]))

    def test_td_order(self) -> None:
        rows = unit_rows("u", "main", ["b", "a", "c"], [0.1, 0.1, 0.2], [0, 0, 0], 0.0)
        rows.loc[2, "coedit_n"] = np.nan
        rows.loc[0, "profiling_n"] = 0.05
        self.assertEqual(evaluate.td_order(rows), ["c", "b", "a"])


class TestEvaluate(TestCase):
    def test_hand_case(self) -> None:
        pr = unit_rows(
            "p",
            "pr_td_off",
            ["a", "b", "c", "d"],
            [0.4, 0.3, 0.2, 0.1],
            [0.1, 0.2, 0.9, 0.0],
            [0.0, 0.0, 1.0, np.nan],
        )
        landed = unit_rows(
            "m",
            "main",
            ["a", "b", "c", "d"],
            [0.4, 0.3, 0.2, 0.1],
            [0.9, 0.1, 0.0, 0.8],
            [1.0, 0.0, 0.0, 1.0],
            fresh=[True, True, True, False],
        )
        explored = unit_rows("x", "explored", ["a"], [0.1], [0.1], [1.0])
        m = evaluate.evaluate(
            lambda f: f["pp"].to_numpy(), pd.concat([pr, landed, explored])
        )
        self.assertEqual(m["units"], 2)
        self.assertEqual(m["events"]["unit"], ["m", "p"])
        self.assertEqual(m["events"]["td"], [True, False])
        self.assertEqual(m["events"]["model"], [True, True])
        self.assertEqual((m["pr"]["td"]["caught"], m["pr"]["model"]["caught"]), (0, 1))
        self.assertEqual(m["pooled"]["model"]["rate"], 1.0)
        self.assertEqual(m["pooled"]["td"]["n"], 2)
        self.assertAlmostEqual(m["pooled"]["test_share"], 0.5)
        self.assertAlmostEqual(m["pooled"]["td"]["cost_share"], 0.5)
        self.assertEqual(m["exponents"], {"0.0": 2})
        self.assertEqual(m["td_cut_no_costs"], 0)
        pr["cost"] = np.nan
        m = evaluate.evaluate(lambda f: f["pp"].to_numpy(), pd.concat([pr, landed]))
        self.assertEqual((m["td_cut_no_costs"], m["exponents"]["None"]), (1, 1))
        self.assertEqual((m["pr"]["td"]["caught"], m["pr"]["model"]["caught"]), (0, 0))
        self.assertAlmostEqual(m["pooled"]["td"]["cost_share"], 0.5)
        self.assertLess(m["pooled"]["td"]["lo"], 0.5)

    def test_rate(self) -> None:
        self.assertEqual(evaluate.rate(0, 0)["rate"], None)
        r = evaluate.rate(5, 10)
        self.assertEqual(r["rate"], 0.5)
        self.assertAlmostEqual(r["lo"], 0.2366, places=3)
        self.assertAlmostEqual(r["hi"], 0.7634, places=3)

    def test_paired_bootstrap(self) -> None:
        self.assertIsNone(evaluate.paired_bootstrap([], [], []))
        units = ["a", "a", "b", "c"]
        same = evaluate.paired_bootstrap([1, 0, 1, 0], [1, 0, 1, 0], units)
        self.assertEqual((same["diff"], same["lo"], same["hi"]), (0.0, 0.0, 0.0))
        better = evaluate.paired_bootstrap([1, 1, 1, 1], [0, 0, 0, 0], units)
        self.assertEqual((better["diff"], better["lo"]), (1.0, 1.0))
        self.assertEqual((better["events"], better["units"]), (4, 3))
        mixed = evaluate.paired_bootstrap([1, 0] * 50, [0, 1] * 50, list(range(100)))
        self.assertLess(mixed["lo"], 0)
        self.assertGreater(mixed["hi"], 0)
        again = evaluate.paired_bootstrap([1, 0] * 50, [0, 1] * 50, list(range(100)))
        self.assertEqual(mixed, again)

    def test_calibration(self) -> None:
        self.assertIsNone(evaluate.calibration([0.5] * 100, [1] * 19 + [0] * 81))
        p = np.array([0.1] * 50 + [0.3] * 50)
        y = np.array([0] * 45 + [1] * 5 + [0] * 35 + [1] * 15)
        c = evaluate.calibration(p, y)
        self.assertAlmostEqual(c["ratio"], 0.2 / 0.2)
        self.assertAlmostEqual(c["base_rate"], 0.2)
        self.assertAlmostEqual(c["brier"], float(np.mean((p - y) ** 2)))
        self.assertEqual(len(c["reliability"]), 10)
        self.assertEqual(sum(b["n"] for b in c["reliability"]), 100)
        self.assertAlmostEqual(c["reliability"][0]["mean_p"], 0.1)

    def test_calibration_rows(self) -> None:
        rows, units = synthetic(n_units=30)
        units.loc[units["unit_id"] == "u29", "train_ok"] = False
        rows.loc[rows["unit_id"] == "u28", "full"] = False
        got = evaluate.calibration_rows(rows, units, CUTOFF)
        self.assertNotIn("u28", set(got["unit_id"]))
        self.assertTrue(got["full"].all())
        self.assertTrue((got["kind"] == "main").all())
        self.assertTrue((got["time"] >= CUTOFF - 56 * DAY).all())
        self.assertNotIn("u29", set(got["unit_id"]))


BOOT_OK = {"diff": 0.02, "lo": -0.01, "hi": 0.05, "events": 300}
BOOT_BAD = {"diff": -0.06, "lo": -0.09, "hi": -0.02, "events": 300}
CAL_OK = {"ratio": 1.1}


class TestGate(TestCase):
    def test_branches(self) -> None:
        cases = {
            "pass": (BOOT_OK, None, CAL_OK, True),
            "below TD": (BOOT_BAD, None, CAL_OK, False),
            "no TD events": (None, None, CAL_OK, False),
            "below live": (BOOT_OK, {**BOOT_BAD, "pr_events": 150}, CAL_OK, False),
            "live ok": (BOOT_OK, {**BOOT_OK, "pr_events": 150}, CAL_OK, True),
            "few live events": (BOOT_OK, {**BOOT_BAD, "pr_events": 99}, CAL_OK, True),
            "no live events": (BOOT_OK, {"pr_events": 0}, CAL_OK, True),
            "calibration skipped": (BOOT_OK, None, None, True),
            "calibration low": (BOOT_OK, None, {"ratio": 0.4}, False),
            "calibration high": (BOOT_OK, None, {"ratio": 2.1}, False),
        }
        for name, (td, live, cal, want) in cases.items():
            with self.subTest(name):
                passed, reasons = gate.gate(td, live, cal)
                self.assertEqual(passed, want, reasons)
                self.assertEqual(
                    want, not any(r.startswith(gate.FAIL) for r in reasons)
                )
        _, reasons = gate.gate(BOOT_OK, None, None)
        self.assertIn("note: model calibration skipped: too few positives", reasons)

    def test_drift(self) -> None:
        self.assertEqual(
            gate.drift(None),
            ["note: live model calibration skipped: too few positives"],
        )
        self.assertTrue(gate.drift({"ratio": 3.0})[0].startswith("note: drift: "))
        self.assertEqual(
            gate.drift({"ratio": 1.0}), ["note: live model calibration ratio 1.00"]
        )


def model_doc(**kw):
    doc = json.loads(FIXTURE.read_text())["doc"]
    doc["trained_at"] = "2026-11-01T00:00:00Z"
    return {**doc, **kw}


class TestStaleness(TestCase):
    now = datetime(2026, 11, 5, tzinfo=timezone.utc)

    def test_states(self) -> None:
        cases = {
            "ok": model_doc(),
            "disabled": model_doc(enabled=False),
            "stale": model_doc(trained_at="2026-10-26T23:00:00Z"),
            "unreadable": FileNotFoundError("no such file"),
            "invalid": model_doc(format=2),
        }
        for want, doc in cases.items():
            with self.subTest(want):
                self.assertEqual(gate.staleness(doc, self.now)[0], want)
        self.assertEqual(
            gate.staleness(model_doc(trained_at="x"), self.now)[0], "invalid"
        )
        bad_risk = model_doc()
        bad_risk["risk"] = {"features": []}
        status, reasons = gate.staleness(bad_risk, self.now)
        self.assertEqual(status, "ok")
        self.assertIn("risk score disabled: risk: bad features", reasons)


class TestCheck(TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / spec.MODEL_FILE

    def tearDown(self) -> None:
        self.dir.cleanup()

    def run_check(self, doc, *extra):
        if doc is not None:
            self.path.write_text(json.dumps(doc))
        with mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            code = cli.main(["check", "--model", str(self.path), "--now", NOW, *extra])
        return code, out.getvalue()

    def test_exit_codes(self) -> None:
        self.assertEqual(self.run_check(model_doc())[0], cli.EXIT_OK)
        self.assertEqual(self.run_check(model_doc(enabled=False))[0], cli.EXIT_OK)
        stale = model_doc(trained_at="2026-10-20T00:00:00Z")
        self.assertEqual(self.run_check(stale)[0], cli.EXIT_CHECK_FAILED)
        self.assertEqual(
            self.run_check(model_doc(features=["x"]))[0], cli.EXIT_CHECK_FAILED
        )
        self.path.write_text("{")
        code, out = self.run_check(None)
        self.assertEqual(code, cli.EXIT_CHECK_FAILED)
        self.assertIn("unreadable", out)
        self.path.write_text(" " * (cli.MAX_MODEL_BYTES + 1))
        self.assertIn("over", self.run_check(None)[1])

    def test_sanitize(self) -> None:
        self.assertEqual(cli.sanitize("a\n::error::x\r\n b"), "a : error: x b")
        self.assertEqual(
            cli.sanitize("x ##[set-env name=A;]b ###[y"), "x # [set-env name=A;]b ## [y"
        )
        self.assertEqual(len(cli.sanitize("x" * 500)), cli.MAX_REASON_CHARS)

    def test_url(self) -> None:
        body = io.BytesIO(json.dumps(model_doc()).encode())
        with mock.patch.object(cli.urllib.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value = body
            self.assertEqual(cli.read_model("https://example.com/m.json"), model_doc())
        self.assertEqual(urlopen.call_args.kwargs["timeout"], cli.FETCH_TIMEOUT_SECONDS)

    def test_metrics(self) -> None:
        cases = {
            "no rows": ([], cli.EXIT_OK, "no td_scorer metric rows"),
            "low": (
                [{"fallback": "", "n": 95}, {"fallback": "x", "n": 5}],
                cli.EXIT_OK,
                "5 of 100",
            ),
            "high": (
                [{"fallback": "", "n": 80}, {"fallback": "ModelError: bad", "n": 20}],
                cli.EXIT_CHECK_FAILED,
                "20: ModelError: bad",
            ),
        }
        for name, (rows, code, text) in cases.items():
            with self.subTest(name), mock.patch.object(
                cli, "fallback_rows", return_value=rows
            ):
                got, out = self.run_check(model_doc(), "--metrics")
                self.assertEqual(got, code)
                self.assertIn(text, out)
        with mock.patch.object(cli, "fallback_rows") as rows:
            self.run_check(model_doc(enabled=False), "--metrics")
            rows.assert_not_called()

    def test_check_imports_only_the_stdlib(self) -> None:
        self.path.write_text(json.dumps(model_doc()))
        code = (
            "import sys\n"
            "for m in ('pandas', 'numpy', 'sklearn', 'threadpoolctl'):\n"
            "    sys.modules[m] = None\n"
            "from torchci.td.scorer import __main__ as cli\n"
            f"sys.exit(cli.main(['check', '--model', {str(self.path)!r}, '--now', {NOW!r}]))\n"
        )
        done = subprocess.run(
            [sys.executable, "-c", code], capture_output=True, text=True
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("td_scorer.json: ok", done.stdout)


class TestRefit(TestCase):
    rows: pd.DataFrame
    units: pd.DataFrame
    limits: threadpool_limits

    @classmethod
    def setUpClass(cls) -> None:
        cls.limits = threadpool_limits(limits=4)
        cls.rows, cls.units = synthetic()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.limits.restore_original_limits()

    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.out = Path(self.dir.name) / "out"

    def tearDown(self) -> None:
        self.dir.cleanup()

    def refit(self, live: str = "", days: str = "120", extra=("--no-llm",), **build):
        args = [
            "refit",
            "--pytorch",
            "pt",
            "--stats-dir",
            "s",
            "--live",
            live,
            "--out",
            str(self.out),
            "--now",
            NOW,
            "--days",
            days,
            *extra,
            "--units-dir",
            self.dir.name,
            "--run-id",
            "42",
            "--commit",
            "0123456789abcdef0123456789abcdef01234567",
        ]
        with mock.patch("torchci.td.scorer.features.build", **build) as b, mock.patch(
            "torchci.td.scorer.features.load_stats", return_value={}
        ), mock.patch.object(pathrisk.History, "load", return_value=HISTORY) as load:
            if "side_effect" not in build:
                b.return_value = (self.rows, self.units)
            self.history_load = load
            return cli.main(args), b

    def test_writes_the_model(self) -> None:
        code, build = self.refit()
        self.assertEqual(code, cli.EXIT_OK)
        self.assertEqual(
            build.call_args.args[3:6],
            (datetime(2026, 7, 4), datetime(2026, 11, 1), datetime(2026, 9, 6)),
        )
        self.assertIsNone(build.call_args.kwargs["llm"])
        self.assertIs(build.call_args.kwargs["history"], HISTORY)
        self.history_load.assert_called_once_with(
            Path("pt"), epoch(datetime(2026, 7, 4))
        )
        doc = json.loads((self.out / spec.MODEL_FILE).read_text())
        self.assertEqual(doc["source"], {"run_id": 42, "commit": "0123456789ab"})
        self.assertEqual(doc["data_through"], "2026-11-01T00:00:00Z")
        self.assertTrue(doc["gate"]["reasons"])
        self.assertGreater(doc["gate"]["recall_vs_td"]["pooled"]["model"]["n"], 0)
        report = json.loads((self.out / cli.REPORT_FILE).read_text())
        self.assertTrue(report["passed"])
        self.assertNotIn("events", report["vs_td"])
        summary = (self.out / cli.SUMMARY_FILE).read_text()
        self.assertIn("# TD scorer refit: passed", summary)
        self.assertIn("| TD |", summary)
        self.assertIn("Platt calibration: yes", summary)
        self.assertIn("TD-off PR units (information only", summary)
        self.assertIsNotNone(report["pr_calibration"])
        self.assertTrue(report["model_calibrated"])
        self.assertEqual(gate.staleness(doc, gate.parse_time(NOW))[0], gate.OK)
        self.assertEqual(
            doc["risk"]["paths"], train.rounded(pathrisk.table(HISTORY, CUTOFF))
        )
        self.assertEqual(list(doc["risk"]["paths"]["nodes"]), ["torch/", "torch/x.py"])
        self.assertIsNone(model_json.validate(doc))

    def test_oversized_model_is_not_written(self) -> None:
        with mock.patch.object(cli, "MAX_MODEL_BYTES", 10_000):
            code, _ = self.refit()
        self.assertEqual(code, cli.EXIT_ERROR)
        self.assertFalse((self.out / spec.MODEL_FILE).exists())
        report = json.loads((self.out / cli.REPORT_FILE).read_text())
        self.assertIn("bytes, over 10000", report["error"])

    def test_calibration_twin_is_out_of_sample(self) -> None:
        with mock.patch.object(train, "fit", wraps=train.fit) as fit:
            out = evaluate.run_gate(self.rows, self.units, CUTOFF, None, NOW, {})
        ends = [c.args[2] for c in fit.call_args_list]
        self.assertEqual(ends, [CUTOFF - 28 * DAY, CUTOFF - 56 * DAY])
        self.assertIsNotNone(out["calibration"])
        rows = self.rows.copy()
        recent = (rows["kind"] == "main") & (rows["time"] >= CUTOFF - 56 * DAY)
        rows.loc[recent, "y"] = 0.0
        with mock.patch.object(train, "fit", wraps=train.fit) as fit:
            out = evaluate.run_gate(rows, self.units, CUTOFF, None, NOW, {})
        self.assertEqual(fit.call_count, 1)
        self.assertIsNone(out["calibration"])
        self.assertIn(
            "note: model calibration skipped: too few positives", out["reasons"]
        )

    def test_window_before_pr_look_back(self) -> None:
        code, build = self.refit(days="363")
        self.assertEqual(code, cli.EXIT_ERROR)
        build.assert_not_called()
        report = json.loads((self.out / cli.REPORT_FILE).read_text())
        self.assertIn("PR look-back", report["error"])
        self.assertEqual(
            cli.parser()
            .parse_args(
                [
                    "refit",
                    "--pytorch",
                    "p",
                    "--stats-dir",
                    "s",
                    "--live",
                    "",
                    "--out",
                    "o",
                ]
            )
            .days,
            360,
        )
        self.assertEqual(self.refit(days="360")[0], cli.EXIT_OK)

    def test_fetch_and_llm_before_the_rows(self) -> None:
        order = mock.Mock()
        selected = [{"unit_id": "u1"}]
        patches = {
            "context.read_labels": ([{"unit_id": "u0"}], {"2026-10": ["t"]}),
            "context.window_units": [{"unit_id": "u0"}],
            "features.selected_units": selected,
            "context.fetch_pr_meta": {7: {}},
            "context.needed_commits": ["a" * 40],
            "context.fetch_commits": set(),
            "context.pr_bases": {"u1": "b" * 40},
            "context.unit_tests": ["t"],
            "llm.unit_diffs": {"u1": "diff"},
            "llm.download_bundle": Path("bundle.tar"),
            "llm.scores": {"u1": {"t": 0.25}},
        }
        with contextlib.ExitStack() as stack:
            for name, value in patches.items():
                m = stack.enter_context(
                    mock.patch(
                        f"torchci.td.scorer.{name}", return_value=value, create=True
                    )
                )
                order.attach_mock(m, name)
            code, build = self.refit(extra=("--fetch", "--threads", "2"))
            scores_call = [c for c in order.mock_calls if c[0] == "llm.scores"][0]
            self.assertEqual(scores_call.args[2](selected[0]), ["t"])
        self.assertEqual(code, cli.EXIT_OK)
        names = [c[0] for c in order.mock_calls if not c[0].endswith("()")]
        self.assertEqual(
            names[:4],
            [
                "context.read_labels",
                "context.window_units",
                "features.selected_units",
                "context.fetch_pr_meta",
            ],
        )
        self.assertLess(
            names.index("context.fetch_commits"), names.index("llm.unit_diffs")
        )
        self.assertEqual(
            order.mock_calls[names.index("context.fetch_commits")].args,
            (Path("pt"), ["a" * 40]),
        )
        diffs_call = [c for c in order.mock_calls if c[0] == "llm.unit_diffs"][0]
        self.assertEqual(diffs_call.args, (selected, Path("pt"), {"u1": "b" * 40}))
        self.assertEqual(build.call_args.kwargs["llm"], {"u1": {"t": 0.25}})

    def test_gate_failure_writes_no_model(self) -> None:
        with mock.patch.object(gate, "gate", return_value=(False, ["FAIL: x"])):
            code, _ = self.refit()
        self.assertEqual(code, cli.EXIT_NOT_WRITTEN)
        self.assertFalse((self.out / spec.MODEL_FILE).exists())
        self.assertIn("FAIL: x", (self.out / cli.SUMMARY_FILE).read_text())

    def test_live_model(self) -> None:
        live = Path(self.dir.name) / "live.json"
        live_doc = train.fit(self.rows, self.units, CUTOFF - 14 * DAY, NOW, {})
        live.write_text(json.dumps(live_doc))
        code, _ = self.refit(str(live))
        self.assertEqual(code, cli.EXIT_OK)
        report = json.loads((self.out / cli.REPORT_FILE).read_text())
        self.assertEqual(report["vs_live"]["since"], "2026-10-18T00:00:00Z")
        self.assertGreater(report["bootstrap_live"]["pr_events"], 0)
        self.assertIsNotNone(report["live_calibration"])
        live.write_text(json.dumps({**live_doc, "enabled": False}))
        self.out = Path(self.dir.name) / "out2"
        code, _ = self.refit(str(live))
        self.assertEqual(code, cli.EXIT_NOT_WRITTEN)
        self.assertFalse((self.out / spec.MODEL_FILE).exists())
        summary = (self.out / cli.SUMMARY_FILE).read_text()
        self.assertIn("FAIL: the live model is disabled", summary)
        self.assertIn("refit: failed", summary)

    def test_error(self) -> None:
        code, _ = self.refit(side_effect=RuntimeError("boom"))
        self.assertEqual(code, cli.EXIT_ERROR)
        report = json.loads((self.out / cli.REPORT_FILE).read_text())
        self.assertEqual(report["error"], "RuntimeError: boom")
        self.assertIn("failed", (self.out / cli.SUMMARY_FILE).read_text())


if __name__ == "__main__":
    main()
