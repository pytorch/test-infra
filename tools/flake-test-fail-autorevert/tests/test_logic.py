from datetime import date, datetime

from flake_test_fail_autorevert.logic import (
    annotate_regression,
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


def test_annotate_regression_without_verdict():
    assert annotate_regression("f.py::t", None, None) == "f.py::t"
    assert annotate_regression("f.py::t", "", None) == "f.py::t"


def test_annotate_regression_with_verdict_and_confidence():
    assert (
        annotate_regression("f.py::t", "related", 0.99) == "f.py::t (related, 0.99)"
    )
    assert (
        annotate_regression("f.py::t", "not_related", 0.891)
        == "f.py::t (not_related, 0.89)"
    )
    assert annotate_regression("f.py::t", "related", 1.0) == "f.py::t (related, 1.00)"


def test_annotate_regression_verdict_without_confidence():
    assert annotate_regression("f.py::t", "related", None) == "f.py::t (related)"


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


def test_build_rows_regression_only():
    rows = build_rows(
        regressions={"a" * 40: {"f.py::t"}},
        flaky={},
        commit_times={"a" * 40: _time(5)},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert len(rows) == 1
    r = rows[0]
    assert r["commit_sha"] == "a" * 40
    assert r["commit_url"] == f"https://github.com/{REPO}/commit/{'a' * 40}"
    assert r["commit_time"] == "2026-07-05 12:00:00"
    assert r["regressions"] == "f.py::t"
    assert r["flaky_signals"] == ""


def test_build_rows_flaky_only():
    rows = build_rows(
        regressions={},
        flaky={"b" * 40: {"g.py::t2", "g.py::t1"}},
        commit_times={"b" * 40: _time(6)},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert len(rows) == 1
    assert rows[0]["regressions"] == ""
    assert rows[0]["flaky_signals"] == "g.py::t1; g.py::t2"


def test_build_rows_both_with_verdict():
    sha = "c" * 40
    rows = build_rows(
        regressions={sha: {"f.py::t"}},
        flaky={sha: {"h.py::flaky"}},
        commit_times={sha: _time(7)},
        verdicts={(sha, "f.py::t"): ("related", 0.99)},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert len(rows) == 1
    assert rows[0]["regressions"] == "f.py::t (related, 0.99)"
    assert rows[0]["flaky_signals"] == "h.py::flaky"


def test_build_rows_multiple_regression_keys_sorted():
    sha = "d" * 40
    rows = build_rows(
        regressions={sha: {"z.py::t", "a.py::t"}},
        flaky={},
        commit_times={sha: _time(8)},
        verdicts={(sha, "a.py::t"): ("related", 0.9)},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert rows[0]["regressions"] == "a.py::t (related, 0.90); z.py::t"


def test_build_rows_excludes_commit_with_neither():
    sha = "e" * 40
    rows = build_rows(
        regressions={sha: set()},
        flaky={sha: set()},
        commit_times={sha: _time(9)},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert rows == []


def test_build_rows_drops_unresolved_sha():
    rows = build_rows(
        regressions={"f" * 40: {"f.py::t"}},
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
        flaky={},
        commit_times={sha: datetime(2026, 6, 30, 23, 59, 59)},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert rows == []


def test_build_rows_sorted_by_time_ascending():
    shas = {"a" * 40: _time(10), "b" * 40: _time(3), "c" * 40: _time(6)}
    rows = build_rows(
        regressions={s: {"f.py::t"} for s in shas},
        flaky={},
        commit_times=shas,
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    times = [r["commit_time"] for r in rows]
    assert times == sorted(times)
    assert times[0] == "2026-07-03 12:00:00"


def test_build_rows_handles_tz_aware_time():
    from datetime import timezone

    sha = "5" * 40
    rows = build_rows(
        regressions={sha: {"f.py::t"}},
        flaky={},
        commit_times={sha: datetime(2026, 7, 5, 12, 0, 0, tzinfo=timezone.utc)},
        verdicts={},
        start_date=START,
        end_date=END,
        repo=REPO,
    )
    assert len(rows) == 1
    assert rows[0]["commit_time"] == "2026-07-05 12:00:00"
