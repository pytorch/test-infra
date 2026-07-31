from datetime import date, datetime

from flake_test_fail_autorevert.logic import (
    build_rows,
    day_bounds,
    endpoint_from_env,
    is_test_signal,
    iter_time_chunks,
)


def test_is_test_signal():
    assert is_test_signal("test_ops.py::test_foo")
    assert is_test_signal("a::b::c")
    assert not is_test_signal("linux-jammy-py3.9-gcc11 / test")
    assert not is_test_signal("some_job_base_name [test]")
    assert not is_test_signal("")
    assert not is_test_signal(None)  # type: ignore[arg-type]


def test_endpoint_from_env_strips_scheme_and_port():
    assert endpoint_from_env("https://host.example:8443") == "host.example"
    assert endpoint_from_env("host.example:8443") == "host.example"
    assert endpoint_from_env("https://host.example") == "host.example"
    assert endpoint_from_env("host.example") == "host.example"


def test_day_bounds():
    start, end = day_bounds(date(2026, 7, 1))
    assert start == datetime(2026, 7, 1, 0, 0, 0)
    assert end == datetime(2026, 7, 2, 0, 0, 0)


def test_iter_time_chunks_single_day_6h():
    chunks = list(iter_time_chunks(date(2026, 7, 1), date(2026, 7, 1), 6))
    assert chunks == [
        (datetime(2026, 7, 1, 0), datetime(2026, 7, 1, 6)),
        (datetime(2026, 7, 1, 6), datetime(2026, 7, 1, 12)),
        (datetime(2026, 7, 1, 12), datetime(2026, 7, 1, 18)),
        (datetime(2026, 7, 1, 18), datetime(2026, 7, 2, 0)),
    ]
    assert chunks[-1][1] == datetime(2026, 7, 2, 0)


def test_iter_time_chunks_two_days_contiguous():
    chunks = list(iter_time_chunks(date(2026, 7, 1), date(2026, 7, 2), 6))
    assert len(chunks) == 8
    assert chunks[0][0] == datetime(2026, 7, 1, 0)
    assert chunks[-1][1] == datetime(2026, 7, 3, 0)
    for prev, cur in zip(chunks, chunks[1:]):
        assert prev[1] == cur[0]


def test_iter_time_chunks_24h_matches_day_windows():
    chunks = list(iter_time_chunks(date(2026, 7, 1), date(2026, 7, 3), 24))
    assert chunks == [
        (datetime(2026, 7, 1), datetime(2026, 7, 2)),
        (datetime(2026, 7, 2), datetime(2026, 7, 3)),
        (datetime(2026, 7, 3), datetime(2026, 7, 4)),
    ]


def test_iter_time_chunks_non_divisible_clamps_final():
    chunks = list(iter_time_chunks(date(2026, 7, 1), date(2026, 7, 1), 5))
    assert chunks == [
        (datetime(2026, 7, 1, 0), datetime(2026, 7, 1, 5)),
        (datetime(2026, 7, 1, 5), datetime(2026, 7, 1, 10)),
        (datetime(2026, 7, 1, 10), datetime(2026, 7, 1, 15)),
        (datetime(2026, 7, 1, 15), datetime(2026, 7, 1, 20)),
        (datetime(2026, 7, 1, 20), datetime(2026, 7, 2, 0)),
    ]
    assert chunks[-1][1] == datetime(2026, 7, 2, 0)
    for prev, cur in zip(chunks, chunks[1:]):
        assert prev[1] == cur[0]


REPO = "pytorch/pytorch"
START = date(2026, 7, 1)
END = date(2026, 7, 14)


def _time(day: int, hour: int = 12) -> datetime:
    return datetime(2026, 7, day, hour, 0, 0)


def test_build_rows_regression_uses_advisor_workflow():
    sha = "a" * 40
    rows = build_rows(
        regressions={sha: {"f.py::t"}},
        single_workflow_by_signal={(sha, "f.py::t"): "trunk"},
        flaky={},
        commit_times={sha: _time(5)},
        verdicts={(sha, "f.py::t"): ("related", 0.99, "inductor")},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert len(rows) == 1
    r = rows[0]
    assert r["commit_sha"] == sha
    assert r["commit_url"] == f"https://github.com/{REPO}/commit/{sha}"
    assert r["commit_time"] == "2026-07-05 12:00:00"
    assert r["category"] == "regression"
    assert r["workflow"] == "inductor"
    assert r["signal_key"] == "f.py::t"
    assert r["advisor_verdict"] == "related"
    assert r["advisor_confidence"] == "0.99"


def test_build_rows_regression_falls_back_to_single_workflow():
    sha = "b" * 40
    rows = build_rows(
        regressions={sha: {"f.py::t"}},
        single_workflow_by_signal={(sha, "f.py::t"): "pull"},
        flaky={},
        commit_times={sha: _time(5)},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert len(rows) == 1
    assert rows[0]["workflow"] == "pull"
    assert rows[0]["advisor_verdict"] == ""
    assert rows[0]["advisor_confidence"] == ""


def test_build_rows_regression_empty_advisor_workflow_falls_through():
    sha = "c" * 40
    rows = build_rows(
        regressions={sha: {"f.py::t"}},
        single_workflow_by_signal={(sha, "f.py::t"): "slow"},
        flaky={},
        commit_times={sha: _time(5)},
        verdicts={(sha, "f.py::t"): ("not_related", 0.72, "")},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert len(rows) == 1
    assert rows[0]["workflow"] == "slow"
    assert rows[0]["advisor_verdict"] == "not_related"
    assert rows[0]["advisor_confidence"] == "0.72"


def test_build_rows_regression_unknown_when_no_source():
    sha = "d" * 40
    rows = build_rows(
        regressions={sha: {"f.py::t"}},
        single_workflow_by_signal={(sha, "f.py::t"): None},
        flaky={},
        commit_times={sha: _time(5)},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert len(rows) == 1
    assert rows[0]["workflow"] == "unknown"


def test_build_rows_flaky_carries_workflow_and_blank_verdict():
    sha = "e" * 40
    rows = build_rows(
        regressions={},
        single_workflow_by_signal={},
        flaky={sha: {("trunk", "g.py::t1")}},
        commit_times={sha: _time(6)},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert len(rows) == 1
    r = rows[0]
    assert r["category"] == "flaky"
    assert r["workflow"] == "trunk"
    assert r["signal_key"] == "g.py::t1"
    assert r["advisor_verdict"] == ""
    assert r["advisor_confidence"] == ""


def test_build_rows_flaky_same_signal_two_workflows_two_rows():
    sha = "f" * 40
    rows = build_rows(
        regressions={},
        single_workflow_by_signal={},
        flaky={sha: {("trunk", "g.py::t1"), ("pull", "g.py::t1")}},
        commit_times={sha: _time(6)},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert len(rows) == 2
    workflows = {r["workflow"] for r in rows}
    assert workflows == {"trunk", "pull"}
    assert all(r["signal_key"] == "g.py::t1" for r in rows)
    assert all(r["category"] == "flaky" for r in rows)


def test_build_rows_regression_and_flaky_same_commit_and_signal():
    sha = "9" * 40
    rows = build_rows(
        regressions={sha: {"f.py::t"}},
        single_workflow_by_signal={(sha, "f.py::t"): "trunk"},
        flaky={sha: {("trunk", "f.py::t")}},
        commit_times={sha: _time(7)},
        verdicts={(sha, "f.py::t"): ("related", 0.99, "trunk")},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert len(rows) == 2
    cats = [r["category"] for r in rows]
    assert cats == ["flaky", "regression"]
    reg = next(r for r in rows if r["category"] == "regression")
    flk = next(r for r in rows if r["category"] == "flaky")
    assert reg["advisor_verdict"] == "related"
    assert reg["advisor_confidence"] == "0.99"
    assert flk["advisor_verdict"] == ""


def test_build_rows_multiple_regression_signals_each_a_row():
    sha = "8" * 40
    rows = build_rows(
        regressions={sha: {"z.py::t", "a.py::t"}},
        single_workflow_by_signal={(sha, "z.py::t"): "pull", (sha, "a.py::t"): "pull"},
        flaky={},
        commit_times={sha: _time(8)},
        verdicts={(sha, "a.py::t"): ("related", 0.9, "trunk")},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert len(rows) == 2
    by_key = {r["signal_key"]: r for r in rows}
    assert by_key["a.py::t"]["workflow"] == "trunk"
    assert by_key["a.py::t"]["advisor_confidence"] == "0.90"
    assert by_key["z.py::t"]["workflow"] == "pull"
    assert by_key["z.py::t"]["advisor_verdict"] == ""


def test_build_rows_two_signals_distinct_sole_workflows_each_attributed():
    sha = "8" * 40
    rows = build_rows(
        regressions={sha: {"A.py::t", "B.py::t"}},
        single_workflow_by_signal={(sha, "A.py::t"): "trunk", (sha, "B.py::t"): "pull"},
        flaky={},
        commit_times={sha: _time(8)},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert len(rows) == 2
    by_key = {r["signal_key"]: r for r in rows}
    assert by_key["A.py::t"]["workflow"] == "trunk"
    assert by_key["B.py::t"]["workflow"] == "pull"
    assert all(r["workflow"] != "unknown" for r in rows)


def test_build_rows_excludes_commit_with_neither():
    sha = "e" * 40
    rows = build_rows(
        regressions={sha: set()},
        single_workflow_by_signal={},
        flaky={sha: set()},
        commit_times={sha: _time(9)},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert rows == []


def test_build_rows_drops_unresolved_sha():
    sha = "f" * 40
    rows = build_rows(
        regressions={sha: {"f.py::t"}},
        single_workflow_by_signal={(sha, "f.py::t"): "trunk"},
        flaky={},
        commit_times={},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert rows == []


def test_build_rows_window_inclusive_end_day():
    sha = "1" * 40
    rows = build_rows(
        regressions={sha: {"f.py::t"}},
        single_workflow_by_signal={(sha, "f.py::t"): "trunk"},
        flaky={},
        commit_times={sha: datetime(2026, 7, 14, 23, 59, 59)},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert len(rows) == 1


def test_build_rows_window_excludes_day_after_end():
    sha = "2" * 40
    rows = build_rows(
        regressions={sha: {"f.py::t"}},
        single_workflow_by_signal={(sha, "f.py::t"): "trunk"},
        flaky={},
        commit_times={sha: datetime(2026, 7, 15, 0, 0, 0)},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert rows == []


def test_build_rows_window_includes_start_midnight():
    sha = "3" * 40
    rows = build_rows(
        regressions={sha: {"f.py::t"}},
        single_workflow_by_signal={(sha, "f.py::t"): "trunk"},
        flaky={},
        commit_times={sha: datetime(2026, 7, 1, 0, 0, 0)},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert len(rows) == 1


def test_build_rows_window_excludes_before_start():
    sha = "4" * 40
    rows = build_rows(
        regressions={sha: {"f.py::t"}},
        single_workflow_by_signal={(sha, "f.py::t"): "trunk"},
        flaky={},
        commit_times={sha: datetime(2026, 6, 30, 23, 59, 59)},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert rows == []


def test_build_rows_sorted_by_time_category_workflow_signal():
    shas = {"a" * 40: _time(10), "b" * 40: _time(3), "c" * 40: _time(6)}
    rows = build_rows(
        regressions={s: {"f.py::t"} for s in shas},
        single_workflow_by_signal={(s, "f.py::t"): "trunk" for s in shas},
        flaky={},
        commit_times=shas,
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    keys = [
        (r["commit_time"], r["category"], r["workflow"], r["signal_key"]) for r in rows
    ]
    assert keys == sorted(keys)
    assert rows[0]["commit_time"] == "2026-07-03 12:00:00"


def test_build_rows_sort_orders_category_workflow_signal_within_commit():
    sha = "7" * 40
    rows = build_rows(
        regressions={sha: {"z.py::t", "a.py::t"}},
        single_workflow_by_signal={(sha, "z.py::t"): "pull", (sha, "a.py::t"): "pull"},
        flaky={sha: {("trunk", "b.py::t")}},
        commit_times={sha: _time(4)},
        verdicts={(sha, "a.py::t"): ("related", 0.9, "inductor")},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    keys = [(r["category"], r["workflow"], r["signal_key"]) for r in rows]
    assert keys == sorted(keys)
    assert keys[0][0] == "flaky"
    assert keys[1][0] == "regression"


def test_build_rows_sort_stable_tiebreak_on_commit_sha():
    sha_hi = "b" * 40
    sha_lo = "a" * 40
    same_time = _time(4)
    rows = build_rows(
        regressions={},
        single_workflow_by_signal={},
        flaky={
            sha_hi: {("periodic", "x.py::t")},
            sha_lo: {("periodic", "x.py::t")},
        },
        commit_times={sha_hi: same_time, sha_lo: same_time},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert [r["commit_sha"] for r in rows] == [sha_lo, sha_hi]


def test_build_rows_handles_tz_aware_time():
    from datetime import timezone

    sha = "5" * 40
    rows = build_rows(
        regressions={sha: {"f.py::t"}},
        single_workflow_by_signal={(sha, "f.py::t"): "trunk"},
        flaky={},
        commit_times={sha: datetime(2026, 7, 5, 12, 0, 0, tzinfo=timezone.utc)},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert len(rows) == 1
    assert rows[0]["commit_time"] == "2026-07-05 12:00:00"


def test_build_rows_confidence_two_decimals():
    sha = "6" * 40
    rows = build_rows(
        regressions={sha: {"f.py::t"}},
        single_workflow_by_signal={(sha, "f.py::t"): "trunk"},
        flaky={},
        commit_times={sha: _time(5)},
        verdicts={(sha, "f.py::t"): ("not_related", 0.891, "pull")},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert rows[0]["advisor_confidence"] == "0.89"
    assert rows[0]["advisor_verdict"] == "not_related"


def test_build_rows_verdict_without_confidence_blank():
    sha = "0" * 40
    rows = build_rows(
        regressions={sha: {"f.py::t"}},
        single_workflow_by_signal={(sha, "f.py::t"): "trunk"},
        flaky={},
        commit_times={sha: _time(5)},
        verdicts={(sha, "f.py::t"): ("related", None, "trunk")},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert rows[0]["advisor_verdict"] == "related"
    assert rows[0]["advisor_confidence"] == ""
