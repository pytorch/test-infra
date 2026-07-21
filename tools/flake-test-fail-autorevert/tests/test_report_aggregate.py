from flake_test_fail_autorevert.report.aggregate import aggregate, RankRow, top_n
from flake_test_fail_autorevert.report.load import Record


def rec(
    sha="a" * 40,
    time="2026-07-01 10:00:00",
    category="flaky",
    workflow="wf1",
    signal="f.py::t",
    verdict="",
    confidence="",
):
    return Record(
        commit_sha=sha,
        commit_url=f"https://github.com/pytorch/pytorch/commit/{sha}",
        commit_time=time,
        category=category,
        workflow=workflow,
        signal_key=signal,
        advisor_verdict=verdict,
        advisor_confidence=confidence,
    )


def test_empty_records_yields_empty_datasets():
    ds = aggregate([], source="x.csv")
    assert ds.days == []
    assert ds.flaky_commits_by_day == []
    assert ds.flaky_signals_by_day == []
    assert ds.regression_commits_by_day == []
    assert ds.flaky_rank_by_signal == []
    assert ds.regression_rank_by_workflow == []
    assert ds.meta.total_rows == 0
    assert ds.meta.distinct_commits == 0
    assert ds.meta.min_day == ""
    assert ds.meta.max_day == ""


def test_distinct_commit_vs_row_count_divergence():
    # Same commit, two flaky signals on the same day:
    # commits_by_day == 1 but signals_by_day == 2.
    records = [
        rec(sha="c1", time="2026-07-01 08:00:00", signal="a.py::t1"),
        rec(sha="c1", time="2026-07-01 09:00:00", signal="a.py::t2"),
    ]
    ds = aggregate(records, source="x.csv")
    assert ds.days == ["2026-07-01"]
    assert ds.flaky_commits_by_day == [1]
    assert ds.flaky_signals_by_day == [2]


def test_day_bucketing_across_multiple_days():
    records = [
        rec(sha="c1", time="2026-07-01 08:00:00"),
        rec(sha="c2", time="2026-07-02 08:00:00"),
        rec(sha="c3", time="2026-07-02 20:00:00"),
    ]
    ds = aggregate(records, source="x.csv")
    assert ds.days == ["2026-07-01", "2026-07-02"]
    assert ds.flaky_commits_by_day == [1, 2]
    assert ds.flaky_signals_by_day == [1, 2]


def test_shared_day_axis_with_zero_fill():
    # flaky on day 1 and day 3, regression on day 2 only:
    # both series must align to the union [d1, d2, d3] with zero-fill.
    records = [
        rec(sha="c1", time="2026-07-01 08:00:00", category="flaky"),
        rec(sha="c2", time="2026-07-02 08:00:00", category="regression"),
        rec(sha="c3", time="2026-07-03 08:00:00", category="flaky"),
    ]
    ds = aggregate(records, source="x.csv")
    assert ds.days == ["2026-07-01", "2026-07-02", "2026-07-03"]
    assert ds.flaky_signals_by_day == [1, 0, 1]
    assert ds.regression_signals_by_day == [0, 1, 0]
    assert ds.flaky_commits_by_day == [1, 0, 1]
    assert ds.regression_commits_by_day == [0, 1, 0]


def test_rank_by_signal_count_desc_with_name_tiebreak():
    records = [
        rec(signal="z.py::t"),
        rec(signal="z.py::t"),
        rec(signal="a.py::t"),
        rec(signal="a.py::t"),
        rec(signal="m.py::t"),
    ]
    ds = aggregate(records, source="x.csv")
    ranks = ds.flaky_rank_by_signal
    # z and a both have count 2; tie broken by name asc -> a before z.
    assert ranks[0] == RankRow(name="a.py::t", count=2)
    assert ranks[1] == RankRow(name="z.py::t", count=2)
    assert ranks[2] == RankRow(name="m.py::t", count=1)


def test_rank_by_workflow_counts_each_row():
    records = [
        rec(workflow="wfB"),
        rec(workflow="wfA"),
        rec(workflow="wfA"),
        rec(workflow="unknown"),
    ]
    ds = aggregate(records, source="x.csv")
    ranks = ds.flaky_rank_by_workflow
    assert ranks[0] == RankRow(name="wfA", count=2)
    assert ranks[1] == RankRow(name="unknown", count=1)
    assert ranks[2] == RankRow(name="wfB", count=1)


def test_same_signal_two_workflows_counted_once_per_workflow():
    # One signal appearing under two workflows contributes to both workflow
    # buckets, and twice to its own signal bucket.
    records = [
        rec(signal="multi.py::t", workflow="wfA"),
        rec(signal="multi.py::t", workflow="wfB"),
    ]
    ds = aggregate(records, source="x.csv")
    assert ds.flaky_rank_by_signal == [RankRow(name="multi.py::t", count=2)]
    wf = {r.name: r.count for r in ds.flaky_rank_by_workflow}
    assert wf == {"wfA": 1, "wfB": 1}


def test_regression_rank_by_signal_carries_latest_verdict():
    records = [
        rec(
            category="regression",
            signal="r.py::t",
            time="2026-07-01 08:00:00",
            verdict="related",
        ),
        rec(
            category="regression",
            signal="r.py::t",
            time="2026-07-03 08:00:00",
            verdict="not_related",
        ),
    ]
    ds = aggregate(records, source="x.csv")
    row = ds.regression_rank_by_signal[0]
    assert row.name == "r.py::t"
    assert row.count == 2
    # Most recent commit_time wins.
    assert row.verdict == "not_related"


def test_regression_signal_verdict_blank_when_none():
    records = [rec(category="regression", signal="r.py::t")]
    ds = aggregate(records, source="x.csv")
    assert ds.regression_rank_by_signal[0].verdict == ""


def test_regression_verdict_ignores_blank_when_earlier_row_has_one():
    records = [
        rec(
            category="regression",
            signal="r.py::t",
            time="2026-07-01 08:00:00",
            verdict="related",
        ),
        rec(
            category="regression",
            signal="r.py::t",
            time="2026-07-05 08:00:00",
            verdict="",
        ),
    ]
    ds = aggregate(records, source="x.csv")
    assert ds.regression_rank_by_signal[0].verdict == "related"


def test_categories_are_separated():
    records = [
        rec(category="flaky", signal="f.py::t"),
        rec(category="regression", signal="r.py::t"),
    ]
    ds = aggregate(records, source="x.csv")
    assert [r.name for r in ds.flaky_rank_by_signal] == ["f.py::t"]
    assert [r.name for r in ds.regression_rank_by_signal] == ["r.py::t"]


def test_meta_totals():
    records = [
        rec(sha="c1", category="flaky", time="2026-07-01 08:00:00"),
        rec(sha="c1", category="regression", time="2026-07-01 09:00:00"),
        rec(sha="c2", category="flaky", time="2026-07-03 08:00:00"),
    ]
    ds = aggregate(records, source="my.csv")
    m = ds.meta
    assert m.source == "my.csv"
    assert m.total_rows == 3
    assert m.distinct_commits == 2
    assert m.flaky_rows == 2
    assert m.regression_rows == 1
    assert m.min_day == "2026-07-01"
    assert m.max_day == "2026-07-03"


def test_top_n_leftover_count():
    rows = [
        RankRow(name="a", count=5),
        RankRow(name="b", count=3),
        RankRow(name="c", count=2),
        RankRow(name="d", count=1),
    ]
    head, leftover = top_n(rows, 2)
    assert [r.name for r in head] == ["a", "b"]
    # leftover = sum of counts of the rows not shown (2 + 1).
    assert leftover == 3


def test_top_n_no_leftover_when_n_exceeds_rows():
    rows = [RankRow(name="a", count=5)]
    head, leftover = top_n(rows, 50)
    assert len(head) == 1
    assert leftover == 0


def test_top_n_zero():
    rows = [RankRow(name="a", count=5), RankRow(name="b", count=2)]
    head, leftover = top_n(rows, 0)
    assert head == []
    assert leftover == 7
