import re

from flake_test_fail_autorevert.report.aggregate import aggregate
from flake_test_fail_autorevert.report.load import Record
from flake_test_fail_autorevert.report.render import escape, render

FAKE_CHARTJS = "/*! Chart.js v4 */ window.Chart=function(){};"


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


def _sample_datasets():
    records = [
        rec(sha="c1", category="flaky", signal="f.py::t1"),
        rec(sha="c2", category="regression", signal="r.py::t1", verdict="related"),
    ]
    return aggregate(records, source="sample.csv")


def test_escape_helper():
    assert escape('<a>&"x"\'') == "&lt;a&gt;&amp;&quot;x&quot;&#x27;"


def test_sections_present_with_charts():
    html = render(_sample_datasets(), title="T", chartjs=FAKE_CHARTJS)
    assert "<h2>Flakiness</h2>" in html
    assert "<h2>Regressions</h2>" in html


def test_four_canvas_ids_present_when_chartjs_given():
    html = render(_sample_datasets(), title="T", chartjs=FAKE_CHARTJS)
    for cid in (
        "chart-flaky-commits",
        "chart-flaky-signals",
        "chart-regression-commits",
        "chart-regression-signals",
    ):
        assert f'id="{cid}"' in html


def test_embedded_json_block_present():
    html = render(_sample_datasets(), title="T", chartjs=FAKE_CHARTJS)
    assert '<script type="application/json" id="report-data">' in html


def test_chartjs_banner_preserved_and_inlined():
    html = render(_sample_datasets(), title="T", chartjs=FAKE_CHARTJS)
    assert "Chart.js v4" in html


def test_source_map_line_stripped():
    js = FAKE_CHARTJS + "\n//# sourceMappingURL=chart.umd.min.js.map"
    html = render(_sample_datasets(), title="T", chartjs=js)
    assert "sourceMappingURL" not in html


def test_charts_unavailable_banner_when_none():
    html = render(_sample_datasets(), title="T", chartjs=None)
    assert "Charts unavailable" in html
    assert 'id="chart-flaky-commits"' not in html


def test_tables_render_without_charts():
    html = render(_sample_datasets(), title="T", chartjs=None)
    assert "<h2>Flakiness</h2>" in html
    assert "<h2>Regressions</h2>" in html
    assert "f.py::t1" in html
    assert "r.py::t1" in html
    # Regression-by-signal verdict column value shows.
    assert "related" in html


def test_no_external_script_or_style_references():
    html = render(_sample_datasets(), title="T", chartjs=FAKE_CHARTJS)
    assert 'src="http' not in html
    assert not re.search(r'href="https?://[^"]+\.css', html)
    assert "cdn.jsdelivr.net" not in html


def test_only_external_urls_are_commit_urls():
    html = render(_sample_datasets(), title="T", chartjs=None)
    urls = re.findall(r"https?://[^\s\"'<>]+", html)
    for url in urls:
        assert url.startswith("https://github.com/pytorch/pytorch/commit/")


def test_html_escaping_of_signal_key():
    nasty = 'evil.py::t[<script>&"x"]'
    records = [rec(category="flaky", signal=nasty)]
    html = render(aggregate(records, source="s.csv"), title="T", chartjs=None)
    assert nasty not in html
    assert escape(nasty) in html
    assert "<script>&" not in html


def test_title_and_source_in_header():
    html = render(_sample_datasets(), title="My Report", chartjs=None)
    assert "My Report" in html
    assert "sample.csv" in html


def test_empty_datasets_still_valid_html():
    ds = aggregate([], source="empty.csv")
    html = render(ds, title="Empty", chartjs=None)
    assert html.startswith("<!doctype html>")
    assert "</html>" in html
    assert "No data" in html
    assert "empty.csv" in html


def test_empty_datasets_with_chartjs_has_no_canvas():
    ds = aggregate([], source="empty.csv")
    html = render(ds, title="Empty", chartjs=FAKE_CHARTJS)
    assert "chart-flaky-commits" not in html


def test_top_n_more_caption():
    records = [
        rec(category="flaky", signal=f"f{i}.py::t") for i in range(5)
    ]
    html = render(aggregate(records, source="s.csv"), title="T", chartjs=None, top=2)
    assert "and 3 more" in html
