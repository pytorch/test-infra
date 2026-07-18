from typing import List

from .aggregate import (
    PREMERGE_STATUS_RUN_SUCCEEDED,
    PREMERGE_STATUS_TD_DESELECTED,
    PREMERGE_STATUS_TOOLTIPS,
    PREMERGE_TOOLTIP_UNDETERMINED,
    PremergeData,
    PremergeRow,
)
from .htmlutil import escape, tip_attr

PREMERGE_HEADING = "Pre-merge status (trunk/pull regressions)"
_NO_DATA = "No pre-merge status data."
_PREMERGE_TOP = 15
_TIP_LEGEND = (
    '<p class="tip-legend">Hover any underlined status for a plain-language '
    "explanation.</p>"
)
# Only http(s) hrefs are emitted; anything else (javascript:, data:, etc.) renders as
# inert text so a malformed commit_url cannot become an executable link.
_SAFE_URL_SCHEMES = ("https://", "http://")

# Funnel CSS lives here (not in render._CSS) to keep render.py under the 400-line cap;
# a second <style> in the body is valid and keeps the report self-contained.
_PREMERGE_CSS = """
<style>
.funnel { max-width: 620px; margin: 4px 0 10px; }
.fn-row { display: flex; align-items: baseline; gap: 10px; padding: 4px 0;
  border-bottom: 1px solid #ebedf0; }
.fn-n { font-size: 18px; font-weight: 600; min-width: 3em; text-align: right;
  font-variant-numeric: tabular-nums; }
.fn-lbl { font-size: 13px; color: #333; }
.fn-row.fn-pass .fn-n { color: #2e7d32; }
.fn-row.fn-fail .fn-n { color: #b3261e; }
.fn-drop { display: flex; gap: 10px; padding: 1px 0 1px 0; color: #a33;
  font-size: 12px; }
.fn-drop .fn-n { min-width: 3em; text-align: right; font-weight: 400;
  color: #a33; font-size: 12px; font-variant-numeric: tabular-nums; }
.fn-caption { color: #555; font-size: 12px; margin: 0 0 8px; }
.explain { margin-top: 28px; }
.explain h3 { font-size: 15px; }
.explain table { border-collapse: collapse; font-size: 13px; width: 100%;
  max-width: 900px; }
.explain td, .explain th { border: 1px solid #e0e2e5; padding: 6px 9px;
  vertical-align: top; text-align: left; }
.explain th { background: #f0f2f5; }
.explain code { background: #eef; padding: 1px 5px; border-radius: 4px;
  font-size: 12px; white-space: nowrap; }
.explain .model { color: #444; font-size: 13px; margin: 10px 0 4px; }
</style>
""".strip()


def _safe_href(url: str) -> str:
    return url if url.startswith(_SAFE_URL_SCHEMES) else ""


def _status_counts(premerge: PremergeData) -> dict:
    return {row.name: row.count for row in premerge.breakdown}


def _fn_row(n: int, label: str, cls: str = "") -> str:
    cls_attr = f" {cls}" if cls else ""
    return (
        f'<div class="fn-row{cls_attr}"><div class="fn-n">{n}</div>'
        f'<div class="fn-lbl">{escape(label)}</div></div>'
    )


def _fn_drop(n: int, label: str, tooltip: str) -> str:
    if n <= 0:
        return ""
    return (
        f'<div class="fn-drop"><div class="fn-n">-{n}</div>'
        f'<div><span{tip_attr(tooltip)}>{escape(label)}</span></div></div>'
    )


def _render_funnel(premerge: PremergeData) -> str:
    c = _status_counts(premerge)
    total = premerge.total_eligible
    undetermined = premerge.buckets.undetermined
    force_merge = c.get("NOT_RUN:force_merge", 0)
    not_in_matrix = c.get("NOT_RUN:not_in_matrix", 0)
    td = c.get(PREMERGE_STATUS_TD_DESELECTED, 0)
    skipped = c.get("NOT_RUN:skipped", 0)
    run_ok = c.get(PREMERGE_STATUS_RUN_SUCCEEDED, 0)
    run_fail = c.get("RUN_FAILED", 0)

    r1 = total - undetermined
    r2 = r1 - force_merge
    r3 = r2 - not_in_matrix
    r4 = r3 - td
    tips = PREMERGE_STATUS_TOOLTIPS
    parts = [
        '<p class="fn-caption">How the pre-merge checks filtered these '
        "failing tests. Each step drops the tests that never produced a "
        "pass/fail; hover a drop for why.</p>",
        '<div class="funnel">',
        _fn_row(total, "eligible (trunk/pull regressions)"),
        _fn_drop(
            undetermined,
            "couldn't determine pre-merge status",
            PREMERGE_TOOLTIP_UNDETERMINED,
        ),
        _fn_row(r1, "pre-merge version identified"),
        _fn_drop(force_merge, "force-merged, gate bypassed", tips["NOT_RUN:force_merge"]),
        _fn_row(r2, "merge gate ran"),
        _fn_drop(
            not_in_matrix,
            "file/config not in the pre-merge matrix",
            tips["NOT_RUN:not_in_matrix"],
        ),
        _fn_row(r3, "test's file was in the matrix"),
        _fn_drop(
            td,
            "deselected by target-determination",
            tips[PREMERGE_STATUS_TD_DESELECTED],
        ),
        _fn_row(r4, "test was selected to run"),
        _fn_drop(skipped, "skipped", tips["NOT_RUN:skipped"]),
        _fn_row(run_ok, "ran and PASSED pre-merge (landrace)", "fn-pass"),
        _fn_row(run_fail, "ran and FAILED pre-merge (merged red)", "fn-fail"),
        "</div>",
    ]
    return "".join(parts)


def _breakdown_table(breakdown: List) -> str:
    body_rows = []
    for i, row in enumerate(breakdown, start=1):
        tooltip = PREMERGE_STATUS_TOOLTIPS.get(row.name, "")
        body_rows.append(
            f"<tr>"
            f'<td class="rank">{i}</td>'
            f'<td class="name"><span{tip_attr(tooltip)}>{escape(row.name)}</span></td>'
            f'<td class="num">{row.count}</td>'
            f"</tr>"
        )
    if not body_rows:
        body_rows.append('<tr><td colspan="3" class="empty">No data</td></tr>')
    return (
        '<div class="card">'
        "<h3>Breakdown by status</h3>"
        '<table class="rank-table"><thead><tr>'
        '<th class="rank" data-type="num">#<span class="ind"></span></th>'
        '<th>Status<span class="ind"></span></th>'
        '<th class="num" data-type="num">Count<span class="ind"></span></th>'
        "</tr></thead><tbody>"
        + "".join(body_rows)
        + "</tbody></table></div>"
    )


def _row_cells(row: PremergeRow) -> str:
    short_sha = escape(row.commit_sha[:10])
    href = _safe_href(row.commit_url)
    link = f'<a href="{escape(href)}">{short_sha}</a>' if href else short_sha
    return (
        f'<td class="name">{link}</td>'
        f'<td class="name">{escape(row.commit_time)}</td>'
        f'<td class="name">{escape(row.workflow)}</td>'
        f'<td class="name">{escape(row.signal_key)}</td>'
    )


def _row_table(
    title: str, rows: List[PremergeRow], limit: int, heading_title: str = ""
) -> str:
    if limit < 0:
        limit = 0
    head = rows[:limit]
    body_rows = [f"<tr>{_row_cells(row)}</tr>" for row in head]
    if not body_rows:
        body_rows.append('<tr><td colspan="4" class="empty">No data</td></tr>')
    more = ""
    leftover = len(rows) - len(head)
    if leftover > 0:
        more = f'<div class="more">and {leftover} more</div>'
    h3_tip = tip_attr(heading_title, "") if heading_title else ""
    return (
        '<div class="card">'
        f"<h3{h3_tip}>{escape(title)}</h3>"
        '<table class="rank-table"><thead><tr>'
        '<th>Commit<span class="ind"></span></th>'
        '<th>Commit time<span class="ind"></span></th>'
        '<th>Workflow<span class="ind"></span></th>'
        '<th>Signal<span class="ind"></span></th>'
        "</tr></thead><tbody>"
        + "".join(body_rows)
        + "</tbody></table>"
        + more
        + "</div>"
    )


def _explanation() -> str:
    rows = [
        (
            "no_merge_record",
            "couldn't look",
            "No merge record identified which pre-merge version to check - a "
            "stacked-PR commit that isn't the top of its stack, a revert, or a "
            "direct push. Status is unknown (a tool limitation, not a CI fact).",
        ),
        (
            "force_merge",
            "gate bypassed",
            "The change was force-merged (-f), so the required checks never ran "
            "this test before it landed. A process finding.",
        ),
        (
            "not_in_matrix",
            "file wasn't tested",
            "The gate ran, but this test's whole job/config was not part of the "
            "pre-merge checks - nothing from its file ran. A coverage gap.",
        ),
        (
            "td_deselected",
            "file tested, this test filtered out",
            "The file's job ran, but target-determination (which skips tests it "
            "predicts are unaffected) did not select this specific test - or it "
            "was renamed/removed. A coverage gap of a finer grain.",
        ),
        (
            "skipped",
            "test reached, but opted out",
            "The test was in the run but explicitly skipped (a skip condition / "
            "platform guard), so it produced no pass/fail. Usually intentional.",
        ),
    ]
    body = "".join(
        f"<tr><td><code>NOT_RUN:{escape(key)}</code></td>"
        f"<td>{escape(short)}</td><td>{escape(desc)}</td></tr>"
        for key, short, desc in rows
    )
    return (
        '<div class="explain">'
        "<h3>What the NOT_RUN reasons mean</h3>"
        '<p class="model">All NOT_RUN reasons mean the test produced no pass/fail '
        "before merge - they differ by <em>where in the pipeline it dropped "
        "out</em>. The funnel above is that pipeline: each stage must pass to "
        "reach the next.</p>"
        '<table><thead><tr><th>Reason</th><th>In one phrase</th>'
        "<th>What happened</th></tr></thead><tbody>"
        + body
        + "</tbody></table>"
        '<p class="model">Only <code>not_in_matrix</code> and '
        "<code>td_deselected</code> are true test-coverage gaps worth chasing. "
        "<code>force_merge</code> is a process signal, <code>skipped</code> is "
        "usually intentional, and <code>no_merge_record</code> is a tool "
        "blind spot.</p>"
        "</div>"
    )


def render_premerge_section(premerge: PremergeData, top: int = _PREMERGE_TOP) -> str:
    heading = f"<h2>{escape(PREMERGE_HEADING)}</h2>"
    if premerge.total_eligible == 0:
        return heading + f'<div class="empty">{escape(_NO_DATA)}</div>'

    td_tooltip = PREMERGE_STATUS_TOOLTIPS[PREMERGE_STATUS_TD_DESELECTED]
    rs_tooltip = PREMERGE_STATUS_TOOLTIPS[PREMERGE_STATUS_RUN_SUCCEEDED]
    funnel = _render_funnel(premerge)
    tables = (
        '<div class="grid">'
        + _breakdown_table(premerge.breakdown)
        + _row_table(
            f"Top {top} {PREMERGE_STATUS_RUN_SUCCEEDED} (landraces)",
            premerge.run_succeeded_rows,
            top,
            rs_tooltip,
        )
        + "</div>"
        + '<div class="grid">'
        + _row_table(
            f"Top {top} {PREMERGE_STATUS_TD_DESELECTED}",
            premerge.td_deselected_rows,
            top,
            td_tooltip,
        )
        + "</div>"
    )
    return (
        _PREMERGE_CSS
        + heading
        + _TIP_LEGEND
        + funnel
        + tables
        + _explanation()
    )
