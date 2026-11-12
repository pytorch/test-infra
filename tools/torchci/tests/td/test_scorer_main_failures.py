import os
import tempfile
from datetime import date, datetime
from pathlib import Path
from typing import Any
from unittest import main, mock, TestCase

from torchci.td.scorer import main_failures as mf
from torchci.td.scorer.logs import active, TDLog


A, B, C, D, E, F, G, H = (ch * 40 for ch in "abcdef98")


def log(raised=(), changed=("torch/a.py",)) -> TDLog:
    return TDLog(
        scores={
            "EditedByPR": {"f1": 1.0},
            "PreviouslyFailedInPR": {"f2": 1.0},
            "Profiling": {"d1": 0.5},
        },
        heuristics=("EditedByPR", "PreviouslyFailedInPR", "Profiling"),
        raised=tuple(raised),
        changed_files=tuple(changed) if changed is not None else None,
        aggregated={"f1": 2.0, "f2": 1.0},
    )


def failure(sha, pr, config, test_file, n_commits=1, day="2026-09-03") -> dict:
    return {
        "landing_sha": sha,
        "landed_at": f"{day} 10:00:00.000",
        "n_commits": str(n_commits),
        "pr": str(pr),
        "config": config,
        "test_file": test_file,
    }


def merge(pr, sha, force=False, ignore=False, **checks) -> dict:
    row = {
        "pr_num": str(pr),
        "merge_commit_sha": sha,
        "last_commit_sha": "h" * 40,
        "comment_id": "1",
        "skip_mandatory_checks": force,
        "ignore_current": ignore,
        "ignore_current_checks": [],
        "flaky_checks": [],
        "broken_trunk_checks": [],
        "ai_not_related_checks": [],
    }
    row.update(checks)
    return row


FIRST_CHUNK = [
    failure(A, 1, "trunk / linux-a / default", "f1"),
    failure(A, 1, "trunk / linux-a / default", "f2"),
    failure(A, 1, "trunk / linux-a / default", "gone"),
    failure(A, 1, "pull / linux-b / distributed", "d1"),
    failure(A, 1, "trunk / linux-c / default", "w1"),
    failure(A, 1, "trunk / macos-m1 / default", "m1"),
    failure(B, 2, "trunk / linux-a / default", "f1"),
    failure(C, 3, "trunk / linux-a / default", "f1"),
    failure(D, 4, "trunk / linux-a / default", "f1"),
    failure(E, 5, "trunk / linux-a / default", "f1", n_commits=2),
    failure(E, 5, "trunk / linux-a / default", "f2", n_commits=2),
    failure(F, 0, "trunk / linux-a / default", "f1"),
    failure(H, 8, "trunk / linux-a / default", "zz"),
]
SECOND_CHUNK = [failure(G, 7, "trunk / linux-a / default", "f9", day="2026-10-05")]
MERGES = [
    merge(
        1, A, flaky_checks=[["trunk / linux-c / test (default, 1, 2, linux.2xlarge)"]]
    ),
    merge(2, B, force=True),
    merge(4, D),
    merge(8, H),
    merge(
        7,
        G,
        ignore=True,
        ignore_current_checks=[
            ["trunk / linux-a / test (default, 2, 2, linux.4xlarge)"]
        ],
    ),
]
RUNS = [{"run_id": "11", "head_sha": A}, {"run_id": "12", "head_sha": A}]
UNITS = [
    {
        "run_id": "11",
        "build_env": "linux-a",
        "test_config": "default",
        "ran": ["f1", "f2", "x"],
    },
    {"run_id": "11", "build_env": "linux-a", "test_config": "slow", "ran": ["f1"]},
    {
        "run_id": "12",
        "build_env": "linux-b",
        "test_config": "distributed",
        "ran": ["d1", "d2"],
    },
]


class FakeCH:
    def __init__(self, chunks=(FIRST_CHUNK, SECOND_CHUNK)) -> None:
        self.chunks = list(chunks)
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    def query(self, name: str, sql: str, params: dict[str, Any]) -> list[dict]:
        self.calls.append((name, sql, params))
        if name == "td_scorer_main_new_failures":
            return self.chunks.pop(0)
        return {
            "td_scorer_main_merges": MERGES,
            "td_scorer_main_runs": RUNS,
            "td_scorer_main_units": UNITS,
        }[name]


def fetch(fake: FakeCH, logs=None):
    logs = {A: log(), G: log(), H: log()} if logs is None else logs
    with mock.patch.object(mf, "query", fake.query), mock.patch.object(
        mf,
        "fetch_head_logs",
        side_effect=lambda shas: {s: logs[s] for s in shas if s in logs},
    ) as heads:
        out = mf.fetch_main_landings(datetime(2026, 9, 1), datetime(2026, 11, 1))
    return out, heads


class TestFetch(TestCase):
    def test_landings_and_exclusions(self) -> None:
        (landings, counts), heads = fetch(FakeCH())
        self.assertEqual(
            counts,
            {
                "landings_found": 8,
                "failures_found": 14,
                "landings_multi_commit": 1,
                "failures_multi_commit": 2,
                "landings_no_pr": 1,
                "failures_no_pr": 1,
                "landings_no_merge": 1,
                "failures_no_merge": 1,
                "landings_force": 1,
                "failures_force": 1,
                "failures_out_of_scope": 1,
                "failures_waived": 2,
                "landings_all_waived": 1,
                "landings_none_ran": 1,
                "landings_no_td_log": 1,
                "failures_no_td_log": 1,
                "failures_not_ran": 2,
                "landings": 1,
                "units": 2,
                "failures": 3,
            },
        )
        self.assertEqual(heads.call_args.args[0], sorted([A, D, H]))
        self.assertEqual(
            landings,
            [
                mf.MainLanding(
                    A,
                    1,
                    "2026-09-03",
                    log(),
                    (
                        mf.MainUnit(
                            "linux-a", "default", ("f1", "f2", "x"), ("f1", "f2")
                        ),
                        mf.MainUnit("linux-b", "distributed", ("d1", "d2"), ("d1",)),
                    ),
                )
            ],
        )

    def test_month_chunks_and_bound_parameters(self) -> None:
        fake = FakeCH()
        fetch(fake)
        names = [c[0] for c in fake.calls]
        self.assertEqual(
            names,
            ["td_scorer_main_new_failures"] * 2
            + ["td_scorer_main_merges", "td_scorer_main_runs", "td_scorer_main_units"],
        )
        windows = [c[2] for c in fake.calls[:2]]
        self.assertEqual(
            windows,
            [
                {"start": "2026-09-01 00:00:00.000", "stop": "2026-10-02 00:00:00.000"},
                {"start": "2026-10-02 00:00:00.000", "stop": "2026-11-01 00:00:00.000"},
            ],
        )
        self.assertEqual(
            fake.calls[2][2],
            {"prs": [1, 2, 3, 4, 7, 8], "shas": sorted([A, B, C, D, G, H])},
        )
        self.assertEqual(fake.calls[3][2], {"shas": sorted([A, H])})
        self.assertEqual(
            fake.calls[4][2],
            {"runs": [11, 12], "shas": sorted([A, H]), "max_failing": 20},
        )
        for _, sql, params in fake.calls:
            self.assertIn("readonly = 2", sql)
            for key, value in params.items():
                self.assertIn("{" + key + ":", sql)
                for item in value if isinstance(value, list) else [value]:
                    if isinstance(item, str):
                        self.assertNotIn(item, sql)

    def test_nothing_found(self) -> None:
        fake = FakeCH(chunks=([], []))
        (landings, counts), heads = fetch(fake)
        self.assertEqual(landings, [])
        self.assertEqual(
            counts,
            {
                "landings_found": 0,
                "failures_found": 0,
                "landings": 0,
                "units": 0,
                "failures": 0,
            },
        )
        self.assertEqual(len(fake.calls), 2)

    def test_errors_propagate(self) -> None:
        def broken(name, sql, params):
            raise RuntimeError(f"{name} query failed: DatabaseError (code 241)")

        with mock.patch.object(mf, "query", broken), self.assertRaises(RuntimeError):
            mf.fetch_main_landings(datetime(2026, 10, 1), datetime(2026, 11, 1))


def landing(units, sha=A, raised=(), changed=("torch/a.py",)) -> mf.MainLanding:
    return mf.MainLanding(sha, 1, "2026-09-03", log(raised, changed), tuple(units))


class TestReplay(TestCase):
    def test_main_run_unit_neutralises_previously_failed(self) -> None:
        run, unit = mf.main_run_unit(
            landing([], raised=("Profiling",)),
            mf.MainUnit("linux-a", "default", ("f1", "f2"), ("f2",)),
        )
        self.assertEqual(run.raised, ["PreviouslyFailedInPR", "Profiling"])
        self.assertEqual(active(run.heuristics, run.raised), {"EditedByPR"})
        self.assertEqual((run.run_id, run.pr, run.head_sha), (0, 1, A))
        self.assertEqual(run.created_at, "2026-09-03")
        self.assertEqual(run.changed_files, ["torch/a.py"])
        self.assertEqual(run.aggregated, {"f1": 2.0})
        self.assertEqual(
            (unit.build_env, unit.test_config, unit.ran, unit.failed),
            ("linux-a", "default", ["f1", "f2"], ["f2"]),
        )
        self.assertEqual((unit.excluded, unit.neither, unit.main_broken), ([], [], []))

    def test_main_run_unit_subtracts_previously_failed_from_aggregated(self) -> None:
        base = log()
        main_log = TDLog(
            scores={
                **base.scores,
                "PreviouslyFailedInPR": {"f2": 1.0, "f3": 0.3, "f4": 1.0, "f5": 1.0},
            },
            heuristics=base.heuristics,
            raised=(),
            changed_files=base.changed_files,
            aggregated={"f1": 2.0, "f2": 1.0, "f3": 0.1 + 0.2, "f4": 1.5},
        )
        run, _ = mf.main_run_unit(
            mf.MainLanding(A, 1, "2026-09-03", main_log, ()),
            mf.MainUnit("e", "c", (), ()),
        )
        self.assertEqual(run.aggregated, {"f1": 2.0, "f4": 0.5})
        self.assertEqual(main_log.aggregated["f2"], 1.0)

    def test_main_run_unit_unknown_changed_files(self) -> None:
        run, _ = mf.main_run_unit(
            landing([], changed=None), mf.MainUnit("e", "c", (), ())
        )
        self.assertIsNone(run.changed_files)

    def test_landings_caught(self) -> None:
        one = landing(
            [
                mf.MainUnit("linux-a", "default", ("f1", "f2", "x"), ("f1", "f2")),
                mf.MainUnit("linux-b", "default", ("f1", "d1"), ("d1",)),
            ]
        )
        two = landing([mf.MainUnit("linux-a", "default", ("f3",), ("f3",))], sha=B)
        seen = []

        def select(run, unit):
            seen.append((run.head_sha, unit.build_env))
            first = {"f1", "x"} if unit.build_env == "linux-a" else {"d1"}
            return [first, set(), set(unit.ran)]

        self.assertEqual(
            mf.landings_caught([one, two], select),
            [(one, [2, 0, 3], 3), (two, [0, 0, 1], 1)],
        )
        self.assertEqual(seen, [(A, "linux-a"), (A, "linux-b"), (B, "linux-a")])
        empty = landing([], sha=C)
        self.assertEqual(
            mf.landings_caught([empty, two], select),
            [(empty, [0, 0, 0], 0), (two, [0, 0, 1], 1)],
        )
        self.assertEqual(mf.landings_caught([], select), [])

    def test_landings_caught_needs_the_same_cuts_every_call(self) -> None:
        one = landing(
            [
                mf.MainUnit("linux-a", "default", ("f1",), ("f1",)),
                mf.MainUnit("linux-b", "default", ("f1",), ("f1",)),
            ]
        )
        sizes = iter([[{"f1"}], [{"f1"}, set()]])
        with self.assertRaises(ValueError):
            mf.landings_caught([one], lambda run, unit: next(sizes))


class TestCache(TestCase):
    def test_round_trip(self) -> None:
        landings = [
            landing([mf.MainUnit("linux-a", "default", ("f1", "f2"), ("f2",))]),
            landing([mf.MainUnit("e", "c", ("a",), ("a",))], sha=B, changed=None),
        ]
        start, stop = date(2026, 10, 1), date(2026, 11, 1)
        counts = {"landings_found": 3, "landings": 2}
        text = mf.dump_landings(landings, start, stop, counts)
        meta = {"start": start, "stop": stop, "counts": counts}
        self.assertEqual(mf.load_landings(text), (landings, meta))
        self.assertEqual(
            mf.load_landings(mf.dump_landings([], start, stop, {})),
            ([], {"start": start, "stop": stop, "counts": {}}),
        )

    def test_rejects_datetimes(self) -> None:
        with self.assertRaises(TypeError):
            mf.dump_landings([], datetime(2026, 10, 1), date(2026, 11, 1), {})

    def test_rejects_other_versions(self) -> None:
        for text in (
            '{"version": 1, "landings": []}',
            '{"version": 0, "landings": []}',
            "[]",
        ):
            with self.assertRaises(ValueError):
                mf.load_landings(text)

    def test_save_is_atomic(self) -> None:
        landings = [landing([mf.MainUnit("e", "c", ("a",), ("a",))])]
        start, stop = date(2026, 10, 1), date(2026, 11, 1)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "landings.json"
            path.write_text("old")
            mf.save_landings(path, landings, start, stop, {"landings": 1})
            self.assertEqual(mf.load_landings(path.read_text())[0], landings)
            self.assertEqual(os.listdir(d), ["landings.json"])
            with mock.patch.object(
                mf, "dump_landings", side_effect=RuntimeError("boom")
            ), self.assertRaises(RuntimeError):
                mf.save_landings(path, landings, start, stop, {})
            self.assertEqual(mf.load_landings(path.read_text())[0], landings)
            self.assertEqual(os.listdir(d), ["landings.json"])


if __name__ == "__main__":
    main()
