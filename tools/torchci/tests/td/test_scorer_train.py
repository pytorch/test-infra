import copy
import json
import math
import re
from pathlib import Path
from unittest import main, TestCase

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from threadpoolctl import threadpool_limits
from torchci.td.labels.schema import DAY
from torchci.td.scorer import model_json, spec, train


FIXTURE = Path(__file__).parent / "fixtures" / "td_scorer_parity.json"
END = 1793491200  # 2026-11-01 00:00 UTC
SOURCE = {"run_id": 7, "commit": "abc1234"}
TRAINED_AT = "2026-11-04T13:00:00Z"


def synthetic(
    n_units: int = 400, n_tests: int = 30, days: int = 120, seed: int = 0
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Rows where fail_n drives the label, two thirds main units, a quarter of the units
    without a positive; the last 56 days are full rows."""
    rng = np.random.default_rng(seed)
    rows, units = [], []
    for i in range(n_units):
        uid, t = f"u{i}", END - days * DAY + i * days * DAY // n_units
        kind = "pr_td_off" if i % 3 == 0 else "main"
        x = rng.random((n_tests, len(spec.SCORER_FEATURES)))
        x[:, 0] *= 0.25
        x[rng.random(x.shape) < 0.05] = np.nan
        fail = np.nan_to_num(x[:, spec.SCORER_FEATURES.index("fail_n")])
        y = (rng.random(n_tests) < 1 / (1 + np.exp(5 - 24 * fail))).astype(float)
        if i % 4 == 1:
            y[:] = 0.0
        frame = pd.DataFrame(x, columns=list(spec.SCORER_FEATURES))
        frame = frame.assign(
            unit_id=uid,
            kind=kind,
            time=t,
            test=[f"test_{j:02d}" for j in range(n_tests)],
            y=y,
            w=1.0,
            fresh=True,
            full=t >= END - 56 * DAY,
            cost=15.0 + 100 * rng.random(n_tests),
            coedit_n=0.0,
            profiling_n=0.0,
        )
        rows.append(frame[list(spec.ROW_COLUMNS)])
        unit = {"unit_id": uid, "kind": kind, "time": t, "train_ok": True}
        unit["n_positives"] = int(y.sum())
        unit.update({f: float(rng.random()) for f in spec.RISK_INPUTS})
        units.append(unit)
    return pd.concat(rows, ignore_index=True), pd.DataFrame(units)


def chain(depth: int) -> dict[str, list]:
    """A tree whose deepest leaf is `depth` splits below the root: internal node 2i has
    the leaf 2i + 1 and the next internal node 2i + 2."""
    n = 2 * depth + 1
    internal = [i % 2 == 0 and i < n - 1 for i in range(n)]
    return {
        "feature": [0 if f else -1 for f in internal],
        "threshold": [0.0] * n,
        "missing_left": [False] * n,
        "left": [i + 1 if f else 0 for i, f in enumerate(internal)],
        "right": [i + 2 if f else 0 for i, f in enumerate(internal)],
        "value": [0.0 if f else 0.1 for f in internal],
        "leaf": [not f for f in internal],
    }


def sklearn_p(model, platt: train.Platt, x: np.ndarray) -> np.ndarray:
    raw = np.clip(model.predict_proba(x)[:, 1], train.CLIP, 1 - train.CLIP)
    z = np.log(raw / (1 - raw))
    return 1 / (1 + np.exp(-(platt.coef * z + platt.intercept)))


def floats(obj):
    if isinstance(obj, dict):
        for v in obj.values():
            yield from floats(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from floats(v)
    elif isinstance(obj, float):
        yield obj


class TestModelJson(TestCase):
    def setUp(self) -> None:
        self.fixture = json.loads(FIXTURE.read_text())
        self.doc = self.fixture["doc"]

    def test_fixture_p_and_risk(self) -> None:
        self.assertIsNone(model_json.validate(self.doc))
        p = model_json.predict(self.doc, self.fixture["rows"])
        for got, want in zip(p, self.fixture["expected_p"]):
            self.assertAlmostEqual(got, want, delta=1e-11)
        risk = model_json.risk(self.doc, self.fixture["risk_values"])
        for got, want in zip(risk, self.fixture["expected_risk"]):
            self.assertAlmostEqual(got, want, delta=1e-11)

    def test_vectorised_matches_reference(self) -> None:
        x = np.array(self.fixture["rows"], dtype=float)
        got = train.predict_matrix(self.doc, x)
        want = model_json.predict(self.doc, self.fixture["rows"])
        self.assertLess(np.abs(got - np.array(want)).max(), 1e-15)

    def test_very_negative_raw_is_clipped(self) -> None:
        doc = copy.deepcopy(self.doc)
        doc["scorer"]["baseline"] = -1000.0
        (p,) = model_json.predict(doc, [[0.0, 0.0, 0.0]])
        z = math.log(1e-7 / (1 - 1e-7))
        self.assertAlmostEqual(p, 1 / (1 + math.exp(-(0.9 * z - 0.4))), delta=1e-15)

    def test_disabled(self) -> None:
        for enabled in (False, None, 1):
            doc = {**self.doc, "enabled": enabled}
            with self.assertRaises(model_json.ModelDisabled):
                model_json.validate(doc)

    def test_each_rule_rejects(self) -> None:
        tree = lambda doc: doc["scorer"]["trees"][0]  # noqa: E731
        deep = chain(model_json.MAX_DEPTH + 1)
        big = {k: tree(self.doc)[k] * 52 for k in model_json.TREE_KEYS}
        cases = {
            "not a dict": lambda d: [],
            "format": lambda d: d.update(format=2),
            "format bool": lambda d: d.update(format=True),
            "no features": lambda d: d.update(features=[]),
            "too many features": lambda d: d.update(features=["fail_n"] * 201),
            "duplicate feature": lambda d: d.update(
                features=["fail_n", "fail_n", "is_pr"]
            ),
            "unknown feature": lambda d: d.update(
                features=["fail_n", "test_seconds", "x"]
            ),
            "feature not str": lambda d: d.update(
                features=[1, "test_seconds", "is_pr"]
            ),
            "no trees": lambda d: d["scorer"].update(trees=[]),
            "too many trees": lambda d: d["scorer"].update(trees=[tree(d)] * 1001),
            "unequal lists": lambda d: tree(d)["value"].append(0.0),
            "too many nodes": lambda d: d["scorer"].update(trees=[big]),
            "total nodes": lambda d: d["scorer"].update(trees=[tree(d)] * 4001),
            "feature index": lambda d: tree(d)["feature"].__setitem__(0, 3),
            "negative feature": lambda d: tree(d)["feature"].__setitem__(0, -1),
            "child not after": lambda d: tree(d)["left"].__setitem__(2, 1),
            "child out of range": lambda d: tree(d)["right"].__setitem__(2, 5),
            "self child": lambda d: tree(d)["left"].__setitem__(0, 0),
            "too deep": lambda d: d["scorer"].update(trees=[deep]),
            "leaf not bool": lambda d: tree(d)["leaf"].__setitem__(1, 1),
            "missing not bool": lambda d: tree(d)["missing_left"].__setitem__(0, 1),
            "index bool": lambda d: tree(d)["left"].__setitem__(0, True),
            "nan threshold": lambda d: tree(d)["threshold"].__setitem__(0, math.nan),
            "inf value": lambda d: tree(d)["value"].__setitem__(1, math.inf),
            "bool value": lambda d: tree(d)["value"].__setitem__(1, True),
            "string value": lambda d: tree(d)["value"].__setitem__(1, "0.1"),
            "baseline": lambda d: d["scorer"].update(baseline=math.nan),
            "no platt": lambda d: d.pop("platt"),
            "platt coef": lambda d: d["platt"].update(coef=math.inf),
            "clip zero": lambda d: d["platt"].update(clip=0.0),
            "clip big": lambda d: d["platt"].update(clip=0.01),
            "no trained_at": lambda d: d.pop("trained_at"),
            "long trained_at": lambda d: d.update(trained_at="2" * 10 + "x" * 23),
        }
        for name, mutate in cases.items():
            doc = copy.deepcopy(self.doc)
            doc = mutate(doc) if name == "not a dict" else (mutate(doc), doc)[1]
            with self.subTest(name), self.assertRaises(model_json.InvalidModel):
                model_json.validate(doc)
        doc = copy.deepcopy(self.doc)
        doc["scorer"]["trees"] = [chain(model_json.MAX_DEPTH)]
        self.assertIsNone(model_json.validate(doc))

    def test_each_risk_rule_disables_only_risk(self) -> None:
        cases = {
            "unknown feature": lambda r: r.update(features=["log_files", "nope"]),
            "duplicate": lambda r: r.update(features=["max_p", "max_p"]),
            "short fill": lambda r: r["fill"].pop(),
            "nan mean": lambda r: r["mean"].__setitem__(0, math.nan),
            "zero scale": lambda r: r["scale"].__setitem__(0, 0.0),
            "bool coef": lambda r: r["coef"].__setitem__(0, False),
            "intercept": lambda r: r.update(intercept=None),
            "one quantile": lambda r: r.update(quantiles=[0.5]),
            "too many": lambda r: r.update(quantiles=[0.5] * 2002),
            "descending": lambda r: r.update(quantiles=[0.2, 0.1]),
            "above one": lambda r: r.update(quantiles=[0.1, 1.5]),
            "shares": lambda r: r.update(share_min=0.3, share_max=0.2),
            "share above one": lambda r: r.update(share_max=1.5),
        }
        for name, mutate in cases.items():
            doc = copy.deepcopy(self.doc)
            mutate(doc["risk"])
            with self.subTest(name):
                self.assertIsInstance(model_json.validate(doc), str)
        doc = copy.deepcopy(self.doc)
        doc["risk"] = []
        self.assertEqual(model_json.validate(doc), "risk: not an object")
        doc.pop("risk")
        self.assertIsNone(model_json.validate(doc))

    def test_digit_runs(self) -> None:
        self.assertTrue(model_json.has_digit_run("x" + "1" * 15))
        self.assertFalse(model_json.has_digit_run("1" * 14 + ".5"))


class TestTrain(TestCase):
    rows: pd.DataFrame
    units: pd.DataFrame
    doc: dict
    limits: threadpool_limits

    @classmethod
    def setUpClass(cls) -> None:
        cls.limits = threadpool_limits(limits=4)
        cls.rows, cls.units = synthetic()
        cls.doc = train.fit(cls.rows, cls.units, END, TRAINED_AT, SOURCE)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.limits.restore_original_limits()

    def test_training_rows(self) -> None:
        rows, units = self.rows.copy(), self.units.copy()
        units.loc[units["unit_id"] == "u1", "train_ok"] = False
        rows.loc[rows["unit_id"] == "u2", "y"] = math.nan
        got = train.training_rows(rows, units, END - 10 * DAY)
        self.assertFalse(got["unit_id"].isin(["u1", "u2"]).any())
        self.assertTrue((got["time"] < END - 10 * DAY).all())
        self.assertTrue(got["full"].any())

    def test_export_shape(self) -> None:
        doc = self.doc
        self.assertIsNone(model_json.validate(doc))
        self.assertEqual(doc["features"], list(spec.SCORER_FEATURES))
        self.assertEqual(doc["source"], SOURCE)
        self.assertEqual(doc["trained_at"], TRAINED_AT)
        self.assertEqual(doc["data_through"], "2026-11-01T00:00:00Z")
        self.assertEqual(doc["gate"], {})
        self.assertEqual(doc["risk"]["features"], list(spec.RISK_FEATURES))
        self.assertTrue(doc["calibrated"])
        self.assertEqual(doc["platt"]["clip"], train.CLIP)
        text = json.dumps(doc)
        self.assertIsNone(re.search(r"[0-9]{15,}", text))
        for x in floats(doc):
            self.assertEqual(x, round(x, train.DECIMALS))

    def test_ranks_the_predictive_feature(self) -> None:
        rows, _ = synthetic(n_units=60, seed=1)
        p = train.predict_matrix(self.doc, train.matrix(rows))
        fail = rows["fail_n"].fillna(0).to_numpy()
        self.assertGreater(p[fail > 0.2].mean(), 5 * p[fail < 0.05].mean())

    def test_platt_calibrates(self) -> None:
        rows, _ = synthetic(n_units=120, seed=2)
        p = train.predict_matrix(self.doc, train.matrix(rows))
        self.assertAlmostEqual(p.mean() / rows["y"].mean(), 1.0, delta=0.2)

    def test_uncalibrated_when_no_landed_positives(self) -> None:
        units = self.units.assign(kind="pr_td_off")
        self.assertEqual(train.fit_platt(self.rows, units, END), train.IDENTITY)
        doc = train.fit(self.rows, units, END, TRAINED_AT, SOURCE, with_risk=False)
        self.assertFalse(doc["calibrated"])
        self.assertEqual(doc["platt"], {"coef": 1.0, "intercept": 0.0, "clip": 1e-7})
        self.assertNotIn("risk", doc)

    def test_export_parity_with_sklearn(self) -> None:
        train_rows = train.training_rows(self.rows, self.units, END)
        model = train.fit_scorer(train_rows)
        platt = train.Platt(0.9, -0.3, True)
        doc = train.export(model, platt, None, TRAINED_AT, END, SOURCE)
        x = np.random.default_rng(3).random((5000, len(spec.SCORER_FEATURES)))
        x[:, 0] *= 0.25
        x[np.random.default_rng(4).random(x.shape) < 0.1] = np.nan
        # Training values often sit exactly on a split threshold.
        x = np.vstack([x, train.matrix(train_rows)])
        want = sklearn_p(model, platt, x)
        got = np.array(model_json.predict(doc, x.tolist()))
        self.assertLess(np.abs(got - want).max(), 1e-6)
        self.assertLess(np.abs(train.predict_matrix(doc, x) - got).max(), 1e-12)

    def test_features_missing_before_their_history(self) -> None:
        rows = self.rows.copy()
        start = END - train.CALIB_DAYS[0] * DAY
        history = ["fail_n", "prev_failed"]
        rows.loc[rows["time"] < start, history] = math.nan
        twin = train.fit_scorer(train.training_rows(rows, self.units, start))
        doc = train.export(twin, train.IDENTITY, None, TRAINED_AT, start, SOURCE)
        used = {f for tree in doc["scorer"]["trees"] for f in tree["feature"]}
        self.assertFalse(used & {spec.SCORER_FEATURES.index(f) for f in history})
        x = train.matrix(rows)
        got = np.array(model_json.predict(doc, x.tolist()))
        self.assertLess(np.abs(got - sklearn_p(twin, train.IDENTITY, x)).max(), 1e-6)
        doc = train.fit(rows, self.units, END, TRAINED_AT, SOURCE, with_risk=False)
        self.assertTrue(doc["calibrated"])

    def test_risk_parity_with_sklearn(self) -> None:
        table = train.risk_table(self.rows, self.units, END, self.doc)
        names = list(spec.RISK_FEATURES)
        x = table[names].astype(float)
        pipe = make_pipeline(
            StandardScaler(),
            LogisticRegression(C=0.1, class_weight="balanced", max_iter=2000),
        ).fit(x.fillna(x.median()), table["y"])
        for i in range(0, len(table), 37):
            values = {f: float(table[f].iloc[i]) for f in names}
            got, f, share = model_json.risk(self.doc, values)
            want = pipe.predict_proba(x.iloc[[i]])[0, 1]
            self.assertAlmostEqual(got, want, delta=1e-6)
            self.assertTrue(0.1 <= share <= 0.2 and 0 <= f <= 1)
        quantiles = self.doc["risk"]["quantiles"]
        self.assertEqual(quantiles, sorted(quantiles))
        shares = [
            model_json.risk(self.doc, {f: table[f].iloc[i] for f in names})[2]
            for i in range(len(table))
        ]
        self.assertAlmostEqual(float(np.mean(shares)), 0.15, delta=0.01)

    def test_risk_table_reweights_subsampled_negatives(self) -> None:
        rows = self.rows[self.rows["unit_id"] == "u1"].copy()
        rows["full"] = False
        units = self.units[self.units["unit_id"] == "u1"]
        table = train.risk_table(rows, units, END, self.doc)
        p = train.predict_matrix(self.doc, train.matrix(rows))
        y = rows["y"].to_numpy()
        self.assertAlmostEqual(
            table["sum_p"].iloc[0], (p * np.where(y == 0, 5, 1)).sum()
        )
        self.assertAlmostEqual(table["max_p"].iloc[0], p.max())
        self.assertAlmostEqual(table["max_llm"].iloc[0], rows["llm_n"].max())
        self.assertEqual(table["y"].iloc[0], int(units["n_positives"].iloc[0] > 0))

    def test_unexportable_risk_is_dropped(self) -> None:
        model = train.fit_scorer(train.training_rows(self.rows, self.units, END))
        risk = dict(self.doc["risk"], scale=[1e-12] * len(spec.RISK_FEATURES))
        doc = train.export(model, train.IDENTITY, risk, TRAINED_AT, END, SOURCE)
        self.assertNotIn("risk", doc)
        self.assertIsNone(model_json.validate(doc))

    def test_landed_units(self) -> None:
        units = self.units.copy()
        units.loc[units["unit_id"] == "u1", "train_ok"] = False
        got = train.landed_units(units, END - 30 * DAY, END - 10 * DAY)
        self.assertTrue((got["kind"] == "main").all() and got["train_ok"].all())
        self.assertTrue(got["time"].between(END - 30 * DAY, END - 10 * DAY - 1).all())
        everything = train.landed_units(units, None, END)
        self.assertEqual(
            len(everything), int(((units["kind"] == "main") & units["train_ok"]).sum())
        )

    def test_round_up(self) -> None:
        for t in (0.1234567891, 0.1234567899, 2.5, -0.0000000004, 1e308):
            r = train.round_up(t)
            self.assertGreaterEqual(r, t)
            self.assertEqual(r, round(r, train.DECIMALS))
            self.assertLessEqual(r - t, 1e-9)
        self.assertEqual(train.round_up(0.1234567891), 0.123456790)

    def test_order_statistics(self) -> None:
        self.assertEqual(
            train.order_statistics(np.array([0.3, 0.1, 0.2])), [0.1, 0.2, 0.3]
        )
        values = np.random.default_rng(0).random(10000)
        got = train.order_statistics(values)
        self.assertEqual(len(got), model_json.MAX_QUANTILES)
        self.assertEqual((got[0], got[-1]), (values.min(), values.max()))

    def test_risk_needs_two_classes(self) -> None:
        table = pd.DataFrame({f: [0.1, 0.2] for f in spec.RISK_FEATURES}).assign(y=0)
        self.assertIsNone(train.fit_risk(table))

    def test_deterministic(self) -> None:
        again = train.fit(self.rows, self.units, END, TRAINED_AT, SOURCE)
        self.assertEqual(json.dumps(again), json.dumps(self.doc))


if __name__ == "__main__":
    main()
