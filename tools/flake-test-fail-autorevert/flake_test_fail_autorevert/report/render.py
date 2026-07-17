import html
import json
from typing import List, NamedTuple, Optional

from .aggregate import Datasets, Meta, RankRow, top_n

_CSS = """
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica,
    Arial, sans-serif;
  margin: 0; padding: 24px; line-height: 1.45; color: #1c1e21;
  background: #f5f6f7;
}
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 32px 0 12px; border-bottom: 2px solid #d0d3d7;
  padding-bottom: 6px; }
h3 { font-size: 14px; margin: 0 0 8px; color: #444; }
.meta { color: #555; font-size: 13px; margin-bottom: 4px; }
.meta code { background: #e7e9eb; padding: 1px 5px; border-radius: 4px; }
.totals { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0 4px; }
.stat { background: #fff; border: 1px solid #d7dade; border-radius: 8px;
  padding: 10px 14px; min-width: 120px; }
.stat .n { font-size: 20px; font-weight: 600; }
.stat .l { font-size: 12px; color: #666; text-transform: uppercase;
  letter-spacing: .03em; }
.banner { background: #fff3cd; border: 1px solid #ffe69c; color: #664d03;
  padding: 10px 14px; border-radius: 8px; margin: 16px 0; font-size: 13px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px;
  align-items: start; }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
.card { background: #fff; border: 1px solid #d7dade; border-radius: 10px;
  padding: 14px; }
.chart-box { position: relative; height: 260px; }
table.rank-table { width: 100%; border-collapse: collapse; font-size: 13px;
  table-layout: fixed; }
table.rank-table th, table.rank-table td { text-align: left; padding: 6px 8px;
  border-bottom: 1px solid #ebedf0; vertical-align: top; }
table.rank-table th { background: #f0f2f5; cursor: pointer;
  user-select: none; position: sticky; top: 0; }
table.rank-table td.name { word-break: break-word; overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
table.rank-table td.num, table.rank-table th.num { text-align: right;
  width: 64px; white-space: nowrap; }
table.rank-table td.rank, table.rank-table th.rank { width: 44px;
  text-align: right; color: #888; }
.verdict { width: 120px; }
.more { color: #666; font-size: 12px; margin-top: 8px; }
.empty { background: #fff; border: 1px solid #d7dade; border-radius: 10px;
  padding: 24px; text-align: center; color: #666; }
""".strip()

_SORT_JS = """
(function () {
  function toNum(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
  function cmp(a, b, numeric) {
    if (numeric) {
      var na = toNum(a), nb = toNum(b);
      if (na === null && nb === null) return 0;
      if (na === null) return 1;
      if (nb === null) return -1;
      return na - nb;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  document.querySelectorAll("table.rank-table").forEach(function (table) {
    var ths = Array.prototype.slice.call(table.querySelectorAll("thead th"));
    ths.forEach(function (th, idx) {
      th.addEventListener("click", function () {
        var tbody = table.querySelector("tbody");
        if (!tbody) return;
        var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
        var numeric = th.getAttribute("data-type") === "num";
        var asc = th.getAttribute("data-asc") !== "true";
        rows.sort(function (r1, r2) {
          var c1 = r1.children[idx].textContent.trim();
          var c2 = r2.children[idx].textContent.trim();
          return asc ? cmp(c1, c2, numeric) : cmp(c2, c1, numeric);
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
        ths.forEach(function (o) {
          o.setAttribute("data-asc", "");
          var s = o.querySelector(".ind"); if (s) s.textContent = "";
        });
        th.setAttribute("data-asc", asc ? "true" : "false");
        var ind = th.querySelector(".ind");
        if (ind) ind.textContent = asc ? " \\u2191" : " \\u2193";
      });
    });
  });
})();
""".strip()

_CHART_INIT_JS = """
(function () {
  if (typeof Chart === "undefined") return;
  var el = document.getElementById("report-data");
  if (!el) return;
  var data = JSON.parse(el.textContent);
  (data.charts || []).forEach(function (c) {
    var canvas = document.getElementById(c.canvas);
    if (!canvas) return;
    new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: c.labels,
        datasets: [{
          label: c.label, data: c.data,
          borderColor: c.color, backgroundColor: c.color,
          tension: 0.2, fill: false, pointRadius: 3
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: true } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    });
  });
})();
""".strip()

_CHARTS_UNAVAILABLE = (
    "Charts unavailable - run once with network access to cache Chart.js "
    "(or omit --no-charts)."
)


def escape(value: str) -> str:
    return html.escape(str(value))


def _json_for_script(obj: object) -> str:
    return (
        json.dumps(obj, ensure_ascii=False)
        .replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
    )


def _strip_source_map(js: str) -> str:
    # The report is a single self-contained offline HTML file with no sidecar
    # .map, so a sourceMappingURL directive would only 404 in the browser.
    lines = js.splitlines()
    while lines and lines[-1].lstrip().startswith("//# sourceMappingURL="):
        lines.pop()
    return "\n".join(lines)


class ChartSpec(NamedTuple):
    key: str
    canvas_id: str
    label: str
    color: str
    data_attr: str


CHART_SPECS = [
    ChartSpec(
        "flaky_commits", "chart-flaky-commits",
        "Flaky commits / day", "#8a63d2", "flaky_commits_by_day",
    ),
    ChartSpec(
        "flaky_signals", "chart-flaky-signals",
        "Flaky signal occurrences / day", "#c86dd7", "flaky_signals_by_day",
    ),
    ChartSpec(
        "regression_commits", "chart-regression-commits",
        "Regression commits / day", "#d9534f", "regression_commits_by_day",
    ),
    ChartSpec(
        "regression_signals", "chart-regression-signals",
        "Regression signal occurrences / day", "#e8833a",
        "regression_signals_by_day",
    ),
]

_CHART_BY_KEY = {spec.key: spec for spec in CHART_SPECS}


def _chart_payload(datasets: Datasets) -> dict:
    days = datasets.days
    return {
        "charts": [
            {
                "canvas": spec.canvas_id,
                "label": spec.label,
                "labels": days,
                "data": getattr(datasets, spec.data_attr),
                "color": spec.color,
            }
            for spec in CHART_SPECS
        ]
    }


def _stat(n: int, label: str) -> str:
    return (
        f'<div class="stat"><div class="n">{n}</div>'
        f'<div class="l">{escape(label)}</div></div>'
    )


def _render_header(title: str, meta: Meta) -> str:
    date_range = (
        f"{escape(meta.min_day)} to {escape(meta.max_day)}"
        if meta.min_day
        else "no dated rows"
    )
    return (
        f"<h1>{escape(title)}</h1>"
        f'<div class="meta">Source: <code>{escape(meta.source)}</code></div>'
        f'<div class="meta">Date range: {date_range}</div>'
        '<div class="totals">'
        + _stat(meta.total_rows, "signal rows")
        + _stat(meta.distinct_commits, "distinct commits")
        + _stat(meta.regression_rows, "regression rows")
        + _stat(meta.flaky_rows, "flaky rows")
        + "</div>"
    )


def _render_canvas(chart_key: str, chartjs: Optional[str]) -> str:
    if chartjs is None:
        return ""
    canvas_id = _CHART_BY_KEY[chart_key].canvas_id
    return f'<div class="chart-box"><canvas id="{canvas_id}"></canvas></div>'


def _render_rank_table(
    title: str, rows: List[RankRow], limit: int, with_verdict: bool
) -> str:
    head, leftover = top_n(rows, limit)
    body_rows = []
    for i, row in enumerate(head, start=1):
        cells = (
            f'<td class="rank">{i}</td>'
            f'<td class="name">{escape(row.name)}</td>'
            f'<td class="num">{row.count}</td>'
        )
        if with_verdict:
            cells += f'<td class="verdict">{escape(row.verdict)}</td>'
        body_rows.append(f"<tr>{cells}</tr>")
    if not head:
        span = 4 if with_verdict else 3
        body_rows.append(
            f'<tr><td colspan="{span}" class="empty">No data</td></tr>'
        )
    more = ""
    if leftover > 0:
        more = (
            f'<div class="more">and {len(rows) - len(head)} more '
            f"({leftover} occurrences)</div>"
        )
    return (
        '<div class="card">'
        f"<h3>{escape(title)}</h3>"
        '<table class="rank-table"><thead><tr>'
        + _header_cells(with_verdict)
        + "</tr></thead><tbody>"
        + "".join(body_rows)
        + "</tbody></table>"
        + more
        + "</div>"
    )


def _header_cells(with_verdict: bool) -> str:
    labels = ["#", "Name", "Count"] + (["Verdict"] if with_verdict else [])
    classes = ["rank", "", "num"] + (["verdict"] if with_verdict else [])
    types = ["num", "", "num"] + ([""] if with_verdict else [])
    out = []
    for label, cls, typ in zip(labels, classes, types):
        attrs = ""
        if cls:
            attrs += f' class="{cls}"'
        if typ:
            attrs += f' data-type="{typ}"'
        out.append(f"<th{attrs}>{escape(label)}<span class=\"ind\"></span></th>")
    return "".join(out)


def _render_section(
    heading: str,
    canvas_a: str,
    canvas_b: str,
    table_signal: str,
    table_workflow: str,
    chartjs: Optional[str],
) -> str:
    charts_html = ""
    if chartjs is not None:
        charts_html = (
            '<div class="grid">'
            f'<div class="card">{canvas_a}</div>'
            f'<div class="card">{canvas_b}</div>'
            "</div>"
        )
    return (
        f"<h2>{escape(heading)}</h2>"
        + charts_html
        + '<div class="grid">'
        + table_signal
        + table_workflow
        + "</div>"
    )


def render(
    datasets: Datasets,
    title: str,
    chartjs: Optional[str],
    top: int = 50,
) -> str:
    meta = datasets.meta
    header = _render_header(title, meta)

    if meta.total_rows == 0:
        body = header + '<div class="empty">No data in the input CSV.</div>'
        return _document(title, body, None, has_data=False)

    banner = ""
    if chartjs is None:
        banner = f'<div class="banner">{escape(_CHARTS_UNAVAILABLE)}</div>'

    flaky = _render_section(
        "Flakiness",
        _render_canvas("flaky_commits", chartjs),
        _render_canvas("flaky_signals", chartjs),
        _render_rank_table(
            "Top flaky signals", datasets.flaky_rank_by_signal, top, False
        ),
        _render_rank_table(
            "Top flaky workflows", datasets.flaky_rank_by_workflow, top, False
        ),
        chartjs,
    )
    regressions = _render_section(
        "Regressions",
        _render_canvas("regression_commits", chartjs),
        _render_canvas("regression_signals", chartjs),
        _render_rank_table(
            "Top regression signals",
            datasets.regression_rank_by_signal,
            top,
            True,
        ),
        _render_rank_table(
            "Top regression workflows",
            datasets.regression_rank_by_workflow,
            top,
            False,
        ),
        chartjs,
    )

    data_json = _json_for_script(_chart_payload(datasets))
    body = header + banner + flaky + regressions
    return _document(title, body, data_json, has_data=True, chartjs=chartjs)


def _document(
    title: str,
    body: str,
    data_json: Optional[str],
    has_data: bool,
    chartjs: Optional[str] = None,
) -> str:
    scripts = ""
    if data_json is not None:
        scripts += (
            f'<script type="application/json" id="report-data">{data_json}</script>'
        )
    if chartjs is not None:
        scripts += "<script>" + _strip_source_map(chartjs) + "</script>"
        scripts += f"<script>{_CHART_INIT_JS}</script>"
    if has_data:
        scripts += f"<script>{_SORT_JS}</script>"
    return (
        "<!doctype html><html lang=\"en\"><head>"
        '<meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{escape(title)}</title>"
        f"<style>{_CSS}</style>"
        "</head><body>"
        + body
        + scripts
        + "</body></html>"
    )
