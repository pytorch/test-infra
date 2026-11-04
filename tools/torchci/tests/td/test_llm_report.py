import json
import math
from unittest import main, TestCase

from torchci.td.llm import report, report_render
from torchci.td.llm.replay import ReplaySummary
from torchci.td.llm.report import config_id, Metrics, Settings


PRS = range(60)
SKELETON, FUNCTIONS = report.CORPUS_NAMES
SMALL, NEXT, BIG4, BIG8 = report.registry_order()
BASE = Settings(SKELETON, "max", True)


def summary(caught=10, logged=10, gained=0, lost=0, kept=1.0, time=0.0, p=1.0):
    return ReplaySummary(20, 0, logged, caught, gained, lost, p, kept, time)


GOOD = (summary(caught=12, gained=2), summary())


def metrics(level=0.5, e1_caught=5, replay=None, shift=0.0) -> Metrics:
    primary = {pr: level + shift * ((pr % 7) - 3) for pr in PRS}
    e1 = {f"e{i}": i < e1_caught for i in range(10)}
    replay = replay or {"rank": GOOD}
    return Metrics(
        e1, {}, primary, primary, primary, replay, {t: s[0] for t, s in replay.items()}
    )


def cost(gb=1.0, per_pr=30.0, tokens=10**6, tps=1000.0, params=1):
    return {
        "bundle_bytes": gb * 1e9,
        "per_pr_seconds": per_pr,
        "corpus_tokens": tokens,
        "tokens_per_second": tps,
        "parameters": params,
        "peak_rss_bytes": 1e9,
    }


def cid(model=SMALL, corpus=SKELETON, agg="max", inst=True) -> str:
    return config_id(model, corpus, agg, inst)


class TestBinaryRules(TestCase):
    def test_superior_and_not_worse_on_e1_wins(self) -> None:
        alt = Settings(FUNCTIONS, "max", True)
        sel = {cid(): metrics(0.5), cid(corpus=FUNCTIONS): metrics(0.7)}
        d = report.Decisions()
        self.assertEqual(d.binary("1. corpus", BASE, alt, sel), alt)
        self.assertGreater(d.comparisons[0].interval.lo, 0)
        self.assertIn("width", d.lines[0])

    def test_superior_but_worse_on_e1_keeps(self) -> None:
        alt = Settings(FUNCTIONS, "max", True)
        sel = {
            cid(): metrics(0.5, e1_caught=6),
            cid(corpus=FUNCTIONS): metrics(0.7, e1_caught=5),
        }
        self.assertEqual(report.Decisions().binary("1. corpus", BASE, alt, sel), BASE)

    def test_not_superior_keeps(self) -> None:
        alt = Settings(SKELETON, "mean", True)
        sel = {
            cid(): metrics(0.5, shift=0.05),
            cid(agg="mean"): metrics(0.5, shift=-0.05),
        }
        d = report.Decisions()
        self.assertEqual(d.binary("2. aggregation", BASE, alt, sel), BASE)
        self.assertLessEqual(d.comparisons[0].interval.lo, 0)

    def test_missing_configs(self) -> None:
        alt = Settings(FUNCTIONS, "max", True)
        d = report.Decisions()
        self.assertIsNone(d.binary("1. corpus", BASE, alt, {}))
        self.assertEqual(d.binary("1. corpus", BASE, alt, {cid(): metrics()}), BASE)
        self.assertIn("not measured", d.lines[1])


class TestModelRule(TestCase):
    def run_rule(self, sel, conf, costs):
        d = report.Decisions()
        return d.model(BASE, sel, conf, costs), d

    def test_registry_order_is_by_committed_size(self) -> None:
        self.assertEqual(
            report.registry_order(), ["qwen3-0.6b", "gemma2", "qwen3-4b", "qwen3-8b"]
        )

    def test_bigger_replaces_when_superior_confirmed_and_within_gates(self) -> None:
        sel = {cid(SMALL): metrics(0.5), cid(BIG4): metrics(0.7)}
        best, d = self.run_rule(sel, sel, {SMALL: cost(1), BIG4: cost(8)})
        self.assertEqual(best, BIG4)
        self.assertIn(f"replaces {SMALL}", d.lines[-1])
        self.assertIn(f"{cid(NEXT)} not measured", "\n".join(d.lines))
        self.assertIn(f"{cid(BIG8)} not measured", "\n".join(d.lines))

    def test_start_is_the_smallest_registry_model(self) -> None:
        sel = {cid(NEXT): metrics(0.5), cid(BIG4): metrics(0.7)}
        best, d = self.run_rule(sel, sel, {NEXT: cost(1), BIG4: cost(8)})
        self.assertIsNone(best)
        self.assertIn(f"no decision without the smallest, {SMALL}", d.lines[-1])

    def test_outside_the_gates_is_reported_not_picked(self) -> None:
        sel = {cid(SMALL): metrics(0.5), cid(BIG8): metrics(0.7)}
        for big in (cost(12.5), cost(1.5, per_pr=200.0), cost(1.5, tokens=10**9)):
            best, d = self.run_rule(sel, sel, {SMALL: cost(1), BIG8: big})
            self.assertEqual(best, SMALL)
            self.assertIn("outside the gates", d.lines[-1])

    def test_incumbent_outside_the_gates_ships_nothing(self) -> None:
        sel = {cid(SMALL): metrics(0.5)}
        best, d = self.run_rule(sel, sel, {SMALL: cost(1, per_pr=200.0)})
        self.assertIsNone(best)
        self.assertIn(f"{SMALL} is outside the gates", d.lines[-1])

    def test_confirmation_must_agree(self) -> None:
        sel = {cid(SMALL): metrics(0.5), cid(BIG4): metrics(0.7)}
        conf = {cid(SMALL): metrics(0.7), cid(BIG4): metrics(0.6)}
        costs = {SMALL: cost(1), BIG4: cost(8)}
        self.assertEqual(self.run_rule(sel, conf, costs)[0], SMALL)
        self.assertEqual(self.run_rule(sel, {}, costs)[0], SMALL)

    def test_gates(self) -> None:
        self.assertEqual(report.job_seconds(cost(1.0, per_pr=30.0)), 180.0 + 2.0 + 30.0)
        self.assertEqual(
            report.build_minutes(cost(tokens=6 * 10**6, tps=1000.0)), 100.0
        )
        self.assertEqual(
            report.gates(cost(12)), {"job": True, "bundle": True, "build": True}
        )
        self.assertFalse(report.gates(cost(12.1))["bundle"])
        self.assertFalse(report.gates(cost(tokens=6 * 10**6))["build"])


class TestTransformAndShip(TestCase):
    def test_pick_most_e1_catches_then_smaller_time_growth(self) -> None:
        replay = {
            "raw": (summary(caught=14), summary(kept=0.97)),
            "top_quarter": (summary(caught=12, time=0.04), summary()),
            "rank": (summary(caught=12, time=0.01), summary(time=0.02)),
        }
        self.assertEqual(report.pick_transform(replay), "rank")

    def test_no_transform_qualifies(self) -> None:
        replay = {
            "raw": (summary(), summary(kept=0.5)),
            "rank": (summary(time=0.06), summary()),
        }
        self.assertIsNone(report.pick_transform(replay))
        self.assertIsNone(
            report.pick_transform({"rank": (summary(time=math.nan), summary())})
        )

    def test_ship_checks(self) -> None:
        self.assertTrue(all(report.ship_checks(*GOOD).values()))
        failing = report.ship_checks(
            summary(caught=8, gained=1, lost=9, p=0.02), summary(kept=0.9)
        )
        self.assertEqual(
            failing,
            {
                "e1_caught_at_least_logged": False,
                "no_significant_e1_loss": False,
                "e2_kept_at_least_98%": False,
                "median_cut_time_growth_at_most_5%": True,
            },
        )


def full(sel_replay=None, conf_replay=None):
    sel, conf = {}, {}
    for corpus in report.CORPUS_NAMES:
        for agg in ("max", "mean"):
            for inst in (True, False):
                for m in (SMALL, BIG8):
                    sel[cid(m, corpus, agg, inst)] = metrics(0.5, replay=sel_replay)
                    conf[cid(m, corpus, agg, inst)] = metrics(0.5, replay=conf_replay)
    return sel, conf


COSTS = {SKELETON: {SMALL: cost(1.2), BIG8: cost(11.0)}}


class TestDecide(TestCase):
    def test_ship_rule_passes(self) -> None:
        sel, conf = full()
        d = report.decide(sel, conf, COSTS)
        self.assertEqual(d.frozen, cid())
        self.assertEqual(d.transform, "rank")
        self.assertEqual(d.verdict, f"switch on {cid()} with transform rank")
        self.assertEqual(len(d.comparisons), 4)

    def test_ship_rule_fails_on_confirmation(self) -> None:
        sel, conf = full(
            conf_replay={"rank": (summary(caught=8, gained=0, lost=2), summary())}
        )
        d = report.decide(sel, conf, COSTS)
        self.assertEqual(d.verdict, report.DO_NOT_SWITCH_ON)
        self.assertFalse(d.ship["e1_caught_at_least_logged"])

    def test_no_transform_means_do_not_switch_on(self) -> None:
        sel, conf = full(sel_replay={"rank": (summary(), summary(kept=0.9))})
        d = report.decide(sel, conf, COSTS)
        self.assertIsNone(d.transform)
        self.assertEqual(d.verdict, report.DO_NOT_SWITCH_ON)
        self.assertEqual(d.ship, {})

    def test_a_sample_never_gets_a_ship_verdict(self) -> None:
        sel, conf = full()
        d = report.decide(sel, conf, COSTS, sampled=True)
        self.assertEqual((d.frozen, d.transform), (cid(), "rank"))
        self.assertEqual((d.verdict, d.ship), (report.SAMPLE_VERDICT, {}))
        sel, conf = full(sel_replay={"rank": (summary(), summary(kept=0.9))})
        self.assertEqual(
            report.decide(sel, conf, COSTS, sampled=True).verdict, report.SAMPLE_VERDICT
        )

    def test_model_rule_reads_the_picked_corpus_costs(self) -> None:
        sel, conf = full()
        sel[cid(corpus=FUNCTIONS)] = metrics(0.7)
        sel[cid(BIG8, corpus=FUNCTIONS)] = metrics(0.9)
        conf[cid(BIG8, corpus=FUNCTIONS)] = metrics(0.9)
        costs = {**COSTS, FUNCTIONS: {SMALL: cost(1.2), BIG8: cost(8.0)}}
        self.assertEqual(
            report.decide(sel, conf, costs).frozen, cid(BIG8, corpus=FUNCTIONS)
        )
        self.assertIsNone(report.decide(sel, conf, COSTS).frozen)

    def test_base_config_missing(self) -> None:
        d = report.decide({}, {}, COSTS)
        self.assertEqual(d.verdict, report.DO_NOT_SWITCH_ON)
        self.assertIsNone(d.frozen)


class TestBuild(TestCase):
    def test_stored_results_to_markdown_and_json(self) -> None:
        events = {
            "e1": {
                "L1": {"date": "2026-09-01", "stack_size": 1},
                "L2": {"date": "2026-10-02", "stack_size": 2},
            },
            "e2": {
                "5:test_a": {"date": "2026-09-02", "pr": 5, "edited": False},
                "6:test_b": {"date": "2026-10-03", "pr": 6, "edited": True},
            },
        }
        stored_replay = {
            "rank": {
                "e1": [
                    {"key": "L1", "rows": [[1, False, True, 10.0, 10.0]], "dropped": 0}
                ],
                "e2": [
                    {
                        "key": "5:test_a",
                        "rows": [[2, True, True, 10.0, 10.2]],
                        "dropped": 1,
                    }
                ],
            }
        }
        result = {
            "e1": {"L1": 0.1, "L2": 0.6},
            "e2": {"5:test_a": 0.2, "6:test_b": 0.3},
            "replay": stored_replay,
            "missing": 1,
        }
        costs = {SKELETON: {SMALL: cost(1.2)}}
        md, out = report_render.build({cid(): result}, events, costs, {"e2_events": 2})
        self.assertIn(f"Verdict: {report.DO_NOT_SWITCH_ON}", md)
        self.assertIn("pilot looked at events through 2026-11-04", md)
        self.assertIn("| rank | 0/1 | 1 | 1/0 |", md)
        self.assertIn("| 0/1 (1) |", md)
        sel = out["standalone"]["selection"][cid()]
        self.assertEqual(
            (sel["e1_caught"], sel["e1_single_caught"], sel["primary"]), (1, 1, 1.0)
        )
        self.assertEqual(out["standalone"]["confirmation"][cid()]["primary_prs"], 0)
        self.assertEqual(out["replay"]["selection"][cid()]["rank"][0]["gained"], 1)
        self.assertNotIn("NaN", json.dumps(out, allow_nan=False))
        md, out = report_render.build({cid(): result}, events, costs, {}, sampled=True)
        self.assertIn(f"Verdict: {report.SAMPLE_VERDICT}", md)


if __name__ == "__main__":
    main()
