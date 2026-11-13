import dataclasses
from datetime import date, timedelta
from typing import Optional
from unittest import main, mock, TestCase

import numpy as np
from torchci.td.scorer import logs, risk, rows, shards, train, trunk, walkforward
from torchci.td.scorer.risk import Head


START_UP = {"linux-a": {"default": 24.0}}
PR7_FILES = ("pr7/only.py", "pr7/also.py")
TIMES = rows.JobTimes(
    {"linux-a": {"default": {"a": 10.0, "b": 10.0, "c": 10.0}}}, START_UP
)


def day_shard(day: date, prs: list[int]) -> shards.DayShard:
    runs, units = [], []
    for i, pr in enumerate(prs):
        run_id = day.toordinal() * 100 + i
        runs.append(
            shards.Run(
                run_id,
                pr,
                f"{pr:020d}{day.toordinal():020d}",
                f"{day} 01:00:00",
                ["Filepath"],
                [],
                {"Filepath": {"a": 1.0, "b": 0.2}},
                ["torch/a.py"] * (1 + pr % 3),
                {"a": 1.0, "b": 0.2},
            )
        )
        units.append(
            shards.Unit(
                run_id,
                "linux-a",
                "default",
                ["a", "b"] + [f"n{j}" for j in range(40)],
                ["c"],
                ["a"] if pr % 2 else [],
                [],
                [],
            )
        )
    return shards.DayShard(day.isoformat(), runs=runs, units=units)


# The tests' own candidate, so that they hold whatever train.CANDIDATES lists.
CANDIDATE = "Trial"


def log_candidate(shard: shards.DayShard, pr: int) -> None:
    """The candidate ran for the shard's run of `pr` and scored n39, which failed."""
    i = [r.pr for r in shard.runs].index(pr)
    run, unit = shard.runs[i], shard.units[i]
    shard.runs[i] = dataclasses.replace(
        run,
        heuristics=run.heuristics + [CANDIDATE],
        scores={**run.scores, CANDIDATE: {"n39": 1.0}},
    )
    shard.units[i] = dataclasses.replace(unit, failed=unit.failed + ["n39"])


class TestFolds(TestCase):
    def test_next_month(self) -> None:
        self.assertEqual(walkforward.next_month(date(2025, 12, 31)), date(2026, 1, 1))
        self.assertEqual(walkforward.next_month(date(2026, 1, 1)), date(2026, 2, 1))

    def test_fold_months_need_a_month_of_training(self) -> None:
        days = [date(2025, 11, 6) + timedelta(days=i) for i in range(100)]
        self.assertEqual(
            walkforward.fold_months(days), [date(2026, 1, 1), date(2026, 2, 1)]
        )
        from_first = [date(2025, 11, 1) + timedelta(days=i) for i in range(40)]
        self.assertEqual(walkforward.fold_months(from_first), [date(2025, 12, 1)])
        self.assertEqual(walkforward.fold_months(days[:50]), [])
        self.assertEqual(walkforward.fold_months([]), [])

    def test_merge_heads(self) -> None:
        a = {"s": Head(1, "s", ["x"], False), "t": Head(2, "t", ["y"], True)}
        b = {"s": Head(1, "s", ["x"], True), "u": Head(3, "u", ["z"], False)}
        merged = {h.head_sha: h for h in walkforward.merge_heads([a, b], {3})}
        self.assertEqual(sorted(merged), ["s", "t"])
        self.assertTrue(merged["s"].positive and merged["t"].positive)
        again = walkforward.merge_heads([b, {"s": Head(1, "s", ["x"], False)}], set())
        self.assertTrue({h.head_sha: h for h in again}["s"].positive)


class TestWalkForward(TestCase):
    def setUp(self) -> None:
        self.days = [date(2025, 12, 1) + timedelta(days=i) for i in range(70)]
        self.shards = {}
        for d in self.days:
            # PR 7 runs, and fails, in every month: no month after the first may
            # evaluate it, and no month may train on it.
            prs = [d.toordinal() % 50 * 10 + k for k in range(1, 7)] + [7]
            self.shards[d] = day_shard(d, prs)

        def landing(day: str, pr: int) -> trunk.TrunkLanding:
            pair = trunk.TrunkPair(pr, f"{day}-head", "linux-a", "default", "a")
            return trunk.TrunkLanding(f"{day}-landing", day, (pair,))

        # PR 7 also lands before both months; as one of their PRs it must stay out
        # of their risk fits, which `PR7_FILES` reaching a trunk head would show.
        pr7_pair = trunk.TrunkPair(7, "pr7-head", "linux-a", "default", "a")
        self.landings = [
            landing("2025-12-20", 100001),
            trunk.TrunkLanding("2025-12-20-pr7", "2025-12-20", (pr7_pair,)),
            landing("2025-12-21", 11),
            landing("2026-01-10", 100002),
        ]
        log = logs.TDLog({"Filepath": {"a": 1.0}}, ("Filepath",), (), ("t/x.py",), {})
        head_logs = {p.head_sha: log for x in self.landings for p in x.pairs}
        head_logs["pr7-head"] = dataclasses.replace(log, changed_files=PR7_FILES)
        self.history = walkforward.History(TIMES, exclude_prs={11})
        for d in self.days:
            self.history.add_shard(d, self.shards[d])
        self.history.finish(self.landings, head_logs)

    def test_history(self) -> None:
        r = self.history.rows
        self.assertIsNotNone(r)
        assert r is not None
        self.assertNotIn(11, set(r.pr.tolist()))
        self.assertEqual(
            sorted(set(r.day[~r.trunk].tolist())), [d.toordinal() for d in self.days]
        )
        self.assertEqual(
            sorted(set(r.day[r.trunk].tolist())),
            [date(2025, 12, 20).toordinal(), date(2026, 1, 10).toordinal()],
        )
        before = date(2026, 1, 1)
        fit = self.history.fit(before, {7}, "v")
        keep = (r.day < before.toordinal()) & (r.pr != 7)
        self.assertEqual(fit.rows, int(keep.sum()))
        self.assertEqual(fit.positives, int(r.label[keep].sum()))
        self.assertEqual(fit.trunk_landings, 1)
        self.assertEqual(fit.model["start_up_seconds"], START_UP)
        sub = r.subset(keep)
        self.assertTrue(np.all(sub.weight <= sub.base_weight))
        self.assertEqual(len(sub), fit.rows)

    def month_prs(self, month: str, before: bool = False) -> set[int]:
        return set().union(
            *(
                {r.pr for r in s.runs}
                for d, s in self.shards.items()
                if (d.isoformat()[:7] < month if before else d.isoformat()[:7] == month)
            )
        )

    def test_no_fold_trains_on_its_month_or_later(self) -> None:
        seen = []
        real_fit = train.fit_scorer

        def fit_scorer(training):
            trunk_days = training.day[training.trunk].tolist()
            seen.append(
                (int(training.day.max()), set(training.pr.tolist()), trunk_days)
            )
            return real_fit(training)

        risk_calls = []
        real_risk = risk.fit_risk

        def fit_risk(heads, trunk_heads):
            risk_calls.append((list(heads), list(trunk_heads)))
            return real_risk(heads, trunk_heads)

        loaded = []

        def load(d):
            loaded.append(d)
            return self.shards[d]

        with mock.patch.object(
            walkforward.train, "fit_scorer", side_effect=fit_scorer
        ), mock.patch.object(walkforward.risk, "fit_risk", side_effect=fit_risk):
            folds = walkforward.walk_forward(self.history, load, TIMES, "v")
        self.assertEqual([f.month for f in folds], ["2026-01", "2026-02"])
        for fold, (last_day, prs, trunk_days), (heads, trunk_heads) in zip(
            folds, seen, risk_calls
        ):
            month = date.fromisoformat(fold.month + "-01").toordinal()
            self.assertLess(last_day, month)
            self.assertTrue(trunk_days)
            self.assertTrue(all(x < month for x in trunk_days))
            self.assertTrue(all(int(h.head_sha[20:]) < month for h in heads))
            self.assertFalse(prs & self.month_prs(fold.month))
            self.assertNotIn(11, prs)
            self.assertNotIn(11, {h.pr for h in heads})
            self.assertNotIn(7, {h.pr for h in heads})
            self.assertNotIn(list(PR7_FILES), [files for files, _ in trunk_heads])
            new = self.month_prs(fold.month) - self.month_prs(fold.month, before=True)
            self.assertNotIn(7, new)
            self.assertEqual(
                fold.report.prs_with_events, sum(pr % 2 == 1 for pr in new)
            )
            new_heads = {
                r.head_sha
                for d, s in self.shards.items()
                if d.isoformat()[:7] == fold.month
                for r in s.runs
                if r.pr in new
            }
            self.assertEqual(len(fold.report.risk_r), len(new_heads))
        self.assertEqual([len(t) for _, t in risk_calls], [1, 2])
        self.assertEqual(folds[0].train_days, 31)
        self.assertEqual(folds[1].train_days, 62)
        self.assertEqual([d for d in loaded if d < date(2026, 1, 1)], [])
        self.assertEqual(folds[0].report.trunk_landings, 1)
        self.assertEqual(folds[1].report.trunk_landings, 0)
        self.assertGreater(folds[0].report.prs_with_events, 0)

        table = walkforward.summary(folds)
        self.assertEqual(
            [row["month"] for row in table], ["2026-01", "2026-02", "total"]
        )
        total = table[-1]
        self.assertEqual(
            total["prs_with_events"], sum(r["prs_with_events"] for r in table[:-1])
        )
        self.assertEqual(total["units"], sum(r["units"] for r in table[:-1]))
        self.assertEqual(total["trunk_landings"], 1)
        self.assertEqual(total["heads"], sum(len(f.report.risk_label) for f in folds))
        text = walkforward.text(folds)
        self.assertIn("total", text)
        self.assertIn("2026-02", text)

    def test_folds(self) -> None:
        specs = list(walkforward.folds(self.history))
        self.assertEqual([s.month for s in specs], [date(2026, 1, 1), date(2026, 2, 1)])
        jan = specs[0]
        self.assertEqual(jan.days[0], date(2026, 1, 1))
        self.assertEqual(jan.days[-1], date(2026, 1, 31))
        self.assertEqual(jan.before, [d for d in self.days if d < jan.month])
        self.assertEqual(jan.prs, self.month_prs("2026-01"))
        self.assertEqual(jan.new_prs, jan.prs - self.month_prs("2026-01", before=True))
        self.assertNotIn(7, jan.new_prs)
        self.assertEqual([x.day for x in jan.landings], ["2026-01-10"])
        self.assertEqual(specs[1].landings, [])

    def test_fold_models_carry_the_budget(self) -> None:
        budget = {"share": 0.2, "spread": 0.5, "cost_exponent": 0.5}
        self.assertNotIn("budget", self.history.fit(date(2026, 1, 1), set(), "v").model)
        fit = self.history.fit(date(2026, 1, 1), set(), "v", budget)
        self.assertEqual(fit.model["budget"], budget)
        models = []
        real = walkforward.evaluate_window

        def evaluate_window(model, *rest):
            models.append(model)
            return real(model, *rest)

        with mock.patch.object(walkforward, "evaluate_window", evaluate_window):
            folds = walkforward.walk_forward(
                self.history, self.shards.__getitem__, TIMES, "v", budget
            )
        self.assertEqual([m["budget"] for m in models], [budget, budget])
        self.assertTrue(all(f.report.share_jobs >= 0 for f in folds))

    def test_assemble(self) -> None:
        with mock.patch.object(
            trunk, "fetch_landings", return_value=self.landings
        ) as fetch, mock.patch.object(trunk, "fetch_head_logs", return_value={}):
            history = walkforward.assemble(
                self.shards.__getitem__, self.days[:3], {11}, TIMES, date(2026, 3, 1)
            )
        self.assertEqual(sorted(history.prs), self.days[:3])
        self.assertEqual(history.landings, self.landings)
        self.assertEqual(fetch.call_args.args[0].date(), self.days[0])
        self.assertEqual(fetch.call_args.args[1].date(), date(2026, 3, 1))

    def test_no_folds(self) -> None:
        self.assertIn("no month", walkforward.text([]))
        self.assertEqual(walkforward.summary([]), [])


class TestCandidates(TestCase):
    def setUp(self) -> None:
        candidates = mock.patch.object(train, "CANDIDATES", (CANDIDATE,))
        candidates.start()
        self.addCleanup(candidates.stop)

    def history(self, since: Optional[date]) -> walkforward.History:
        """70 days from 2025-12-01 of six new PRs each; from `since` on, the candidate
        runs for each day's first PR. Two PRs of 2026-02-03, the first one and another,
        break trunk on n39."""
        self.days = [date(2025, 12, 1) + timedelta(days=i) for i in range(70)]
        self.shards = {}
        for d in self.days:
            first = d.toordinal() * 10 + 1
            self.shards[d] = day_shard(d, [first + k for k in range(6)])
            if since is not None and d >= since:
                log_candidate(self.shards[d], first)
        landed = date(2026, 2, 3)
        self.landings = [
            trunk.TrunkLanding(
                f"landing-{r.pr}",
                landed.isoformat(),
                (trunk.TrunkPair(r.pr, r.head_sha, "linux-a", "default", "n39"),),
            )
            for r in self.shards[landed].runs[:2]
        ]
        history = walkforward.History(TIMES, exclude_prs=set())
        for d in self.days:
            history.add_shard(d, self.shards[d])
        history.finish(self.landings, {})
        return history

    def first_prs(self, start: date, stop: date) -> set[int]:
        return {d.toordinal() * 10 + 1 for d in self.days if start <= d < stop}

    def test_history_tracks_the_prs_where_a_candidate_was_active(self) -> None:
        day = date(2026, 1, 1)
        shard = day_shard(day, [1, 2, 3, 4, 5])
        logged = ["Filepath", CANDIDATE]
        changes: list[dict[str, list[str]]] = [
            {"heuristics": logged},
            {"raised": [CANDIDATE]},
            {"heuristics": logged, "raised": [CANDIDATE]},
            {"heuristics": ["Filepath", "Forged"]},
        ]
        for i, change in enumerate(changes):
            shard.runs[i] = dataclasses.replace(shard.runs[i], **change)
        history = walkforward.History(TIMES, exclude_prs=set())
        history.add_shard(day, shard)
        self.assertEqual(history.candidate_prs, {1})
        # One run where it ran is enough.
        later = day_shard(day + timedelta(days=1), [1, 5])
        later.runs[0] = dataclasses.replace(later.runs[0], raised=[CANDIDATE])
        later.runs[1] = dataclasses.replace(later.runs[1], heuristics=logged)
        history.add_shard(day + timedelta(days=1), later)
        self.assertEqual(history.candidate_prs, {1, 5})

    def test_no_candidate_logged_fits_nothing(self) -> None:
        history = self.history(None)
        self.assertEqual(history.candidate_prs, set())
        with mock.patch.object(
            walkforward.train, "fit_scorer"
        ) as fit, mock.patch.object(walkforward, "evaluate_window") as window:
            compared = walkforward.candidates(
                history, self.shards.__getitem__, TIMES, "v"
            )
        self.assertEqual(compared, ([], []))
        fit.assert_not_called()
        window.assert_not_called()
        self.assertIn("no walk-forward month", walkforward.candidates_text(*compared))

    def test_both_models_score_the_candidate_prs(self) -> None:
        since = date(2026, 1, 10)
        history = self.history(since)
        fitted, windows = [], []
        real_fit, real_window = train.fit_scorer, walkforward.evaluate_window

        def fit_scorer(training, *allowed):
            fitted.append((int(training.day.max()), set(training.pr.tolist()), allowed))
            return real_fit(training, *allowed)

        def evaluate_window(model, day_shards, prs, landings, times):
            windows.append((set(model["scorer"]["heuristics"]), prs, landings))
            self.assertNotIn("budget", model)
            return real_window(model, day_shards, prs, landings, times)

        with mock.patch.object(
            walkforward.train, "fit_scorer", side_effect=fit_scorer
        ), mock.patch.object(walkforward, "evaluate_window", evaluate_window):
            base, added = walkforward.candidates(
                history, self.shards.__getitem__, TIMES, "v"
            )
        months = [date(2026, 1, 1), date(2026, 2, 1), date(2026, 3, 1)]
        self.assertEqual([f.month for f in base], ["2026-01", "2026-02"])
        self.assertEqual([f.month for f in added], ["2026-01", "2026-02"])
        self.assertEqual([f.train_days for f in added], [31, 62])
        # Per month, newest first, the model over train.HEURISTICS and then the one
        # with the candidates, both on the days before the month.
        allowed = train.HEURISTICS + (CANDIDATE,)
        self.assertEqual([a for _, _, a in fitted], [(), (allowed,)] * 2)
        for (last_day, prs, _), month in zip(fitted, [months[1]] * 2 + [months[0]] * 2):
            self.assertLess(last_day, month.toordinal())
            self.assertTrue(all(pr // 10 < month.toordinal() for pr in prs))
        both = [{"Filepath"}, {"Filepath", CANDIDATE}]
        self.assertEqual([names for names, _, _ in windows], both * 2)
        # Both score the month's new PRs where the candidate ran, and their landings.
        jan = self.first_prs(since, months[1])
        feb = self.first_prs(months[1], months[2])
        self.assertEqual([prs for _, prs, _ in windows], [feb, feb, jan, jan])
        self.assertEqual(
            [x for _, _, x in windows], [self.landings[:1], self.landings[:1], [], []]
        )
        for folds in (base, added):
            self.assertEqual([f.report.prs for f in folds], [22, 8])
            self.assertEqual([f.report.prs_with_events for f in folds], [22, 8])
            self.assertEqual([f.report.pr_events for f in folds], [44, 16])
            # TD's include list holds a, not n39.
            self.assertEqual([f.report.td_recall_sum for f in folds], [11.0, 4.0])
            self.assertEqual([f.report.trunk_landings for f in folds], [0, 1])
        # January's models are fitted on December, before the candidate was logged: it
        # gets no weight. February's model with the candidate also runs n39.
        self.assertEqual([f.report.pr_recall_sum for f in base], [11.0, 4.0])
        self.assertEqual([f.report.pr_recall_sum for f in added], [11.0, 8.0])
        self.assertEqual([f.report.trunk_caught for f in base], [0, 0])
        self.assertEqual([f.report.trunk_caught for f in added], [0, 1])

        table = walkforward.candidates_summary(base, added)
        self.assertEqual((table["heuristics"], table["prs"]), ([CANDIDATE], 30))
        for side in ("scorer", "with_candidates"):
            self.assertEqual(
                [row["month"] for row in table[side]], ["2026-01", "2026-02", "total"]
            )
        total, with_total = table["scorer"][-1], table["with_candidates"][-1]
        self.assertEqual((total["scorer"], total["td"], total["ratio"]), (15, 15, 1))
        self.assertEqual((with_total["scorer"], with_total["td"]), (19, 15))
        self.assertEqual(
            (total["event_recall"], with_total["event_recall"]), (0.5, 38 / 60)
        )
        text = walkforward.candidates_text(base, added)
        self.assertIn(
            "candidates (report only): Trial, on the 30 PRs where a candidate ran", text
        )
        self.assertEqual(len(text.splitlines()), 5)

    def test_out_of_time_the_older_months_are_left_out(self) -> None:
        history = self.history(date(2026, 1, 10))
        load = self.shards.__getitem__
        # The clock: at the start, before February, then past the 50 s.
        clock = iter([0.0, 0.0])
        with mock.patch.object(
            walkforward.time, "monotonic", lambda: next(clock, 100.0)
        ), self.assertLogs(walkforward.logger, level="WARNING") as logs:
            base, added = walkforward.candidates(history, load, TIMES, "v", seconds=50)
        self.assertEqual([f.month for f in base], ["2026-02"])
        self.assertEqual([f.month for f in added], ["2026-02"])
        self.assertIn("after 1 months, 2026-01 and earlier left out", logs.output[0])
        with self.assertLogs(walkforward.logger, level="WARNING"):
            compared = walkforward.candidates(history, load, TIMES, "v", seconds=-1)
        self.assertEqual(compared, ([], []))


if __name__ == "__main__":
    main()
