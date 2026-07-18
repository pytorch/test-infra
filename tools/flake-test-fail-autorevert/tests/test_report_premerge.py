import re

from flake_test_fail_autorevert.report.aggregate import (
    PREMERGE_STATUS_RUN_SUCCEEDED,
    PREMERGE_STATUS_TD_DESELECTED,
    PREMERGE_STATUS_TOOLTIPS,
    PREMERGE_TOOLTIP_UNDETERMINED,
    aggregate,
)
from flake_test_fail_autorevert.report.load import Record
from flake_test_fail_autorevert.report.premerge_render import (
    PREMERGE_HEADING,
    render_premerge_section,
)
from flake_test_fail_autorevert.report.render import escape, render

ALL_STATUSES = [
    "RUN_SUCCEEDED",
    "RUN_FAILED",
    "NOT_RUN:force_merge",
    "NOT_RUN:skipped",
    "NOT_RUN:td_deselected",
    "NOT_RUN:not_in_matrix",
    "NOT_RUN:no_merge_record",
    "ERROR",
]

FAKE_CHARTJS = "/*! Chart.js v4 */ window.Chart=function(){};"


def rec(
    sha="a" * 40,
    time="2026-07-01 10:00:00",
    category="regression",
    workflow="trunk",
    signal="f.py::t",
    verdict="",
    confidence="",
    premerge="",
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
        premerge_status=premerge,
    )


def _one_per_status():
    records = [
        rec(sha=f"s{i}", signal=f"s{i}.py::t", premerge=status)
        for i, status in enumerate(ALL_STATUSES)
    ]
    # Two rows with empty premerge_status must be excluded entirely.
    records.append(rec(sha="empty1", category="flaky", workflow="inductor"))
    records.append(rec(sha="empty2", category="regression", premerge=""))
    return records


def test_buckets_partition_eligible_rows():
    ds = aggregate(_one_per_status(), source="x.csv")
    pm = ds.premerge
    # 8 statuses, one row each; 2 empty rows excluded.
    assert pm.total_eligible == 8
    b = pm.buckets
    assert b.td_deselected == 1
    assert b.run_succeeded == 1
    # undetermined = no_merge_record + ERROR
    assert b.undetermined == 2
    # other = RUN_FAILED + force_merge + skipped + not_in_matrix
    assert b.other == 4
    assert b.total == pm.total_eligible == 8


def test_buckets_group_undetermined_and_other():
    records = [
        rec(sha="a1", premerge="NOT_RUN:no_merge_record"),
        rec(sha="a2", premerge="ERROR"),
        rec(sha="a3", premerge="RUN_FAILED"),
        rec(sha="a4", premerge="NOT_RUN:force_merge"),
        rec(sha="a5", premerge="NOT_RUN:skipped"),
        rec(sha="a6", premerge="NOT_RUN:not_in_matrix"),
        rec(sha="a7", premerge="RUN_SUCCEEDED"),
        rec(sha="a8", premerge="NOT_RUN:td_deselected"),
    ]
    b = aggregate(records, source="x.csv").premerge.buckets
    assert b.undetermined == 2
    assert b.other == 4
    assert b.run_succeeded == 1
    assert b.td_deselected == 1
    assert b.total == 8


def test_empty_premerge_rows_excluded():
    records = [
        rec(sha="c1", premerge="RUN_SUCCEEDED"),
        rec(sha="c2", category="flaky", workflow="win", premerge=""),
        rec(sha="c3", category="regression", workflow="inductor", premerge=""),
    ]
    pm = aggregate(records, source="x.csv").premerge
    assert pm.total_eligible == 1
    assert pm.buckets.run_succeeded == 1
    assert pm.buckets.total == 1


def test_breakdown_counts_desc_with_name_tiebreak():
    records = [
        rec(sha="r1", premerge="RUN_SUCCEEDED"),
        rec(sha="r2", premerge="RUN_SUCCEEDED"),
        rec(sha="e1", premerge="ERROR"),
        rec(sha="e2", premerge="ERROR"),
        rec(sha="f1", premerge="RUN_FAILED"),
    ]
    breakdown = aggregate(records, source="x.csv").premerge.breakdown
    # RUN_SUCCEEDED and ERROR both count 2; tie broken by name asc.
    assert breakdown[0].name == "ERROR"
    assert breakdown[0].signals == 2
    assert breakdown[1].name == "RUN_SUCCEEDED"
    assert breakdown[1].signals == 2
    assert breakdown[2].name == "RUN_FAILED"
    assert breakdown[2].signals == 1
    # Each sha is distinct, so commit counts mirror signal counts here.
    assert breakdown[0].commits == 2
    assert breakdown[1].commits == 2
    assert breakdown[2].commits == 1


def test_every_status_has_a_tooltip():
    for status in ALL_STATUSES:
        assert status in PREMERGE_STATUS_TOOLTIPS
        assert PREMERGE_STATUS_TOOLTIPS[status]


def test_breakdown_renders_correct_tooltip_titles():
    html = render_premerge_section(aggregate(_one_per_status(), source="x.csv").premerge)
    for status, tooltip in PREMERGE_STATUS_TOOLTIPS.items():
        # skipped is folded into not_in_matrix for the report, so its tooltip
        # is intentionally absent from rendered output.
        if status == "NOT_RUN:skipped":
            assert f'data-tip="{escape(tooltip)}"' not in html
            continue
        # CSS tooltip carries the verbatim text in data-tip, escaped for the
        # attribute (several tooltips contain apostrophes).
        assert f'data-tip="{escape(tooltip)}"' in html


def test_skipped_is_reported_as_not_in_matrix():
    # Report-only remap: a NOT_RUN:skipped input row is counted and rendered as
    # NOT_RUN:not_in_matrix; skipped never appears as a DATA value (funnel /
    # breakdown). It may still be named in the explanation reference table.
    records = [
        rec(sha="a", signal="a.py::t", premerge="NOT_RUN:skipped"),
        rec(sha="b", signal="b.py::t", premerge="NOT_RUN:not_in_matrix"),
    ]
    pm = aggregate(records, source="x.csv").premerge
    counts = {r.name: r.signals for r in pm.breakdown}
    assert counts.get("NOT_RUN:not_in_matrix") == 2
    assert "NOT_RUN:skipped" not in counts
    html = render_premerge_section(pm)
    # skipped must not appear as a breakdown status cell / tooltip data value.
    assert 'data-tip' in html
    skipped_tip = PREMERGE_STATUS_TOOLTIPS["NOT_RUN:skipped"]
    assert f'data-tip="{escape(skipped_tip)}"' not in html
    assert '<span class="tip" data-tip="' + escape(skipped_tip) not in html


def test_breakdown_rows_wrap_status_in_titled_span():
    html = render_premerge_section(aggregate(_one_per_status(), source="x.csv").premerge)
    # RUN_FAILED only appears in the breakdown table, so a tip span proves
    # the per-status hover is on the breakdown row itself, not just a card.
    tip = PREMERGE_STATUS_TOOLTIPS["RUN_FAILED"]
    assert f'<span class="tip" data-tip="{escape(tip)}">RUN_FAILED</span>' in html
    assert "already failed while the change was still a pull request" in tip


def test_funnel_shows_stage_counts_and_drops():
    # The funnel replaces the 4 stat cards: it renders a count per pipeline
    # stage and hoverable drop rows for the tests that fell out at each stage.
    html = render_premerge_section(aggregate(_one_per_status(), source="x.csv").premerge)
    # eligible total (8) as the first stage number, and the two terminal
    # outcomes as pass/fail rows.
    assert '<div class="fn-n">8</div>' in html
    assert 'fn-row fn-pass' in html and 'ran and PASSED pre-merge (landrace)' in html
    assert 'fn-row fn-fail' in html and 'ran and FAILED pre-merge (merged red)' in html
    # each drop carries the plain-language tooltip via data-tip, and a -N count.
    fm_tip = PREMERGE_STATUS_TOOLTIPS["NOT_RUN:force_merge"]
    assert f'data-tip="{escape(fm_tip)}"' in html
    assert '<div class="fn-n">-2</div>' in html  # undetermined = no_merge_record+ERROR
    assert "couldn&#x27;t determine pre-merge status" in html
    # no bar markup remains.
    assert "fn-bar" not in html
    assert "style=\"width:" not in html


def test_commit_funnel_td_is_sticky_over_runner():
    records = [
        rec(sha="c1", signal="a.py::t", premerge="NOT_RUN:td_deselected"),
        rec(sha="c1", signal="b.py::t", premerge="RUN_SUCCEEDED"),
        rec(sha="c2", signal="c.py::t", premerge="RUN_SUCCEEDED"),
    ]
    pm = aggregate(records, source="x.csv").premerge
    assert pm.total_eligible == 3
    assert pm.total_eligible_commits == 2
    sig = {r.name: r.signals for r in pm.breakdown}
    com = {r.name: r.commits for r in pm.breakdown}
    assert sig["RUN_SUCCEEDED"] == 2 and sig["NOT_RUN:td_deselected"] == 1
    assert com["NOT_RUN:td_deselected"] == 1
    assert com["RUN_SUCCEEDED"] == 1
    assert sum(r.commits for r in pm.breakdown) == 2


def test_commit_funnel_furthest_down_without_td():
    records = [
        rec(sha="c1", signal="a.py::t", premerge="NOT_RUN:not_in_matrix"),
        rec(sha="c1", signal="b.py::t", premerge="RUN_SUCCEEDED"),
    ]
    pm = aggregate(records, source="x.csv").premerge
    com = {r.name: r.commits for r in pm.breakdown}
    assert pm.total_eligible_commits == 1
    assert com.get("RUN_SUCCEEDED") == 1
    assert com.get("NOT_RUN:not_in_matrix", 0) == 0


def test_commit_funnel_failed_beats_passed():
    records = [
        rec(sha="c1", signal="a.py::t", premerge="RUN_SUCCEEDED"),
        rec(sha="c1", signal="b.py::t", premerge="RUN_FAILED"),
    ]
    pm = aggregate(records, source="x.csv").premerge
    com = {r.name: r.commits for r in pm.breakdown}
    assert pm.total_eligible_commits == 1
    assert com.get("RUN_FAILED") == 1
    assert com.get("RUN_SUCCEEDED", 0) == 0


def test_render_shows_both_funnels_and_commit_column():
    pm = aggregate(_one_per_status(), source="x.csv").premerge
    html = render_premerge_section(pm)
    assert "By failing test" in html
    assert "By commit" in html
    assert ">Signals<" in html
    assert ">Commits<" in html


def test_table_headings_have_titles():
    html = render_premerge_section(aggregate(_one_per_status(), source="x.csv").premerge, top=50)
    rs_tip = PREMERGE_STATUS_TOOLTIPS[PREMERGE_STATUS_RUN_SUCCEEDED]
    td_tip = PREMERGE_STATUS_TOOLTIPS[PREMERGE_STATUS_TD_DESELECTED]
    assert (
        f'<h3 class="tip" data-tip="{escape(rs_tip)}">'
        f"Top 50 {PREMERGE_STATUS_RUN_SUCCEEDED} (landraces)</h3>"
    ) in html
    assert (
        f'<h3 class="tip" data-tip="{escape(td_tip)}">'
        f"Top 50 {PREMERGE_STATUS_TD_DESELECTED}</h3>"
    ) in html


def test_default_top_is_15():
    # The two row tables default to Top 15 (not 50).
    html = render_premerge_section(aggregate(_one_per_status(), source="x.csv").premerge)
    assert "Top 15 RUN_SUCCEEDED (landraces)" in html
    assert "Top 15 NOT_RUN:td_deselected" in html
    assert "Top 50" not in html


def test_explanation_block_present():
    # The NOT_RUN funnel explanation renders at the bottom with all five reasons.
    html = render_premerge_section(aggregate(_one_per_status(), source="x.csv").premerge)
    assert "What the NOT_RUN reasons mean" in html
    for key in (
        "no_merge_record",
        "force_merge",
        "not_in_matrix",
        "td_deselected",
        "skipped",
    ):
        assert f"<code>NOT_RUN:{key}</code>" in html
    # The plain-language phrasing for the confusable pair is spelled out.
    assert "file wasn&#x27;t tested" in html
    assert "file tested, this test filtered out" in html


def test_no_unexplained_jargon_in_hovers():
    html = render_premerge_section(aggregate(_one_per_status(), source="x.csv").premerge)
    # These terms must not appear as bare, unexplained hover text. "pre-merge
    # gate CI" and "ghstack" are gone entirely; "target-determination" now
    # appears only in the explanation table where it is defined in context.
    for jargon in ("pre-merge gate CI", "ghstack"):
        assert jargon not in html



def test_top_50_run_succeeded_cap_and_sort():
    records = []
    for i in range(60):
        # Ascending time with i; s059 is newest, s000 oldest.
        records.append(
            rec(
                sha=f"c{i:03d}",
                time=f"2026-07-01 00:{i:02d}:00",
                signal=f"s{i:03d}.py::t",
                premerge="RUN_SUCCEEDED",
            )
        )
    # An independent td_deselected row must not contaminate the RS list.
    records.append(rec(sha="tdx", signal="td.py::t", premerge="NOT_RUN:td_deselected"))
    pm = aggregate(records, source="x.csv").premerge
    section = render_premerge_section(pm, top=50)

    assert len(pm.run_succeeded_rows) == 60
    # Most recent first.
    times = [r.commit_time for r in pm.run_succeeded_rows]
    assert times == sorted(times, reverse=True)
    assert pm.run_succeeded_rows[0].signal_key == "s059.py::t"

    # Landrace table shows exactly 50 rows + "and 10 more".
    ls_block = section.split("Top 50 RUN_SUCCEEDED")[1].split("Top 50 NOT_RUN")[0]
    tbody = ls_block.split("<tbody>")[1].split("</tbody>")[0]
    assert tbody.count("<tr>") == 50
    assert "and 10 more" in section
    # Newest 50 kept (s010..s059); oldest 10 (s000..s009) dropped.
    assert "s010.py::t" in ls_block
    assert "s009.py::t" not in ls_block
    # td_deselected list is independent and short.
    assert len(pm.td_deselected_rows) == 1
    assert pm.td_deselected_rows[0].signal_key == "td.py::t"


def test_td_deselected_top_list_independent():
    records = [
        rec(sha=f"t{i}", signal=f"t{i}.py::t", premerge="NOT_RUN:td_deselected")
        for i in range(3)
    ]
    records += [rec(sha="rs", signal="rs.py::t", premerge="RUN_SUCCEEDED")]
    pm = aggregate(records, source="x.csv").premerge
    assert len(pm.td_deselected_rows) == 3
    assert len(pm.run_succeeded_rows) == 1


def test_empty_section_renders_no_data_note():
    records = [rec(sha="c1", category="flaky", workflow="win", premerge="")]
    ds = aggregate(records, source="x.csv")
    assert ds.premerge.total_eligible == 0
    html = render(ds, title="T", chartjs=None)
    assert f"<h2>{PREMERGE_HEADING}</h2>" in html
    assert "No pre-merge status data" in html
    assert html.startswith("<!doctype html>")
    assert "</html>" in html


def test_section_present_in_full_render_both_modes():
    ds = aggregate(_one_per_status(), source="x.csv")
    for chartjs in (FAKE_CHARTJS, None):
        html = render(ds, title="T", chartjs=chartjs)
        assert f"<h2>{PREMERGE_HEADING}</h2>" in html
        assert "What the NOT_RUN reasons mean" in html
        assert "Top 15 RUN_SUCCEEDED (landraces)" in html
        assert "Top 15 NOT_RUN:td_deselected" in html


def test_commit_links_use_commit_url():
    records = [rec(sha="abc123def456", premerge="RUN_SUCCEEDED")]
    ds = aggregate(records, source="x.csv")
    html = render(ds, title="T", chartjs=None)
    assert 'href="https://github.com/pytorch/pytorch/commit/abc123def456"' in html


def test_section_introduces_no_external_http_refs():
    ds = aggregate(_one_per_status(), source="x.csv")
    section = render_premerge_section(ds.premerge)
    assert 'src="http' not in section
    assert not re.search(r'href="https?://(?!github\.com/pytorch/pytorch/commit/)', section)
    assert "cdn.jsdelivr.net" not in section


def test_tooltip_html_is_escaped():
    html = render_premerge_section(aggregate(_one_per_status(), source="x.csv").premerge)
    for status, tooltip in PREMERGE_STATUS_TOOLTIPS.items():
        # Tooltips carry no raw markup, but several contain apostrophes that
        # must be entity-escaped inside the title attribute.
        assert "<" not in tooltip and ">" not in tooltip
        # skipped is folded into not_in_matrix, so its tooltip is not rendered.
        if status == "NOT_RUN:skipped":
            continue
        assert escape(tooltip) in html
    # An apostrophe-bearing tooltip proves escaping actually ran.
    apos = PREMERGE_STATUS_TOOLTIPS["RUN_SUCCEEDED"]
    assert "'" in apos
    assert apos not in html
    assert escape(apos) in html
