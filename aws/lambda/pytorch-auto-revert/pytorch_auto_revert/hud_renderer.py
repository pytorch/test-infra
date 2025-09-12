from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple

from .signal import (
    AutorevertPattern,
    RestartCommits,
    Signal,
    SignalCommit,
    SignalEvent,
    SignalStatus,
)


@dataclass
class Column:
    workflow_name: str
    key: str  # signal key
    signal: Signal


@dataclass
class GridModel:
    commits: List[str]  # newest -> older
    columns: List[Column]
    # commit sha -> set of highlight classes
    row_highlights: Dict[str, Set[str]]
    # (workflow, key) -> human note for detection result
    column_notes: Dict[Tuple[str, str], str]


def collect_commit_order(signals: List[Signal]) -> List[str]:
    seen: Set[str] = set()
    ordered: List[str] = []
    for sig in signals:
        for c in sig.commits:
            if c.head_sha not in seen:
                seen.add(c.head_sha)
                ordered.append(c.head_sha)
    return ordered


def build_grid_model(signals: List[Signal]) -> GridModel:
    commits = collect_commit_order(signals)
    columns = [
        Column(workflow_name=s.workflow_name, key=s.key, signal=s) for s in signals
    ]

    row_highlights: Dict[str, Set[str]] = {sha: set() for sha in commits}
    column_notes: Dict[Tuple[str, str], str] = {}

    # run detection and capture highlights/notes
    for s in signals:
        res = s.process_valid_autorevert_pattern()
        note: Optional[str] = None
        if isinstance(res, AutorevertPattern):
            # highlight rows involved in the pattern
            for sha in res.newer_failing_commits:
                row_highlights.setdefault(sha, set()).add("hl-newer-fail")
            row_highlights.setdefault(res.suspected_commit, set()).add("hl-suspected")
            row_highlights.setdefault(res.older_successful_commit, set()).add(
                "hl-baseline"
            )
            note = (
                f"Pattern: newer fail {len(res.newer_failing_commits)};"
                f" suspect {res.suspected_commit[:7]}"
                f" vs baseline {res.older_successful_commit[:7]}"
            )
        elif isinstance(res, RestartCommits):
            for sha in res.commit_shas:
                row_highlights.setdefault(sha, set()).add("hl-restart")
            if res.commit_shas:
                note = f"Suggest restart: {', '.join(sorted(s[:7] for s in res.commit_shas))}"
        if note:
            column_notes[(s.workflow_name, s.key)] = note

    return GridModel(
        commits=commits,
        columns=columns,
        row_highlights=row_highlights,
        column_notes=column_notes,
    )


def _status_icon(status: SignalStatus) -> str:
    if status == SignalStatus.FAILURE:
        return "&#10060;"  # cross mark
    if status == SignalStatus.SUCCESS:
        return "&#9989;"  # check mark button
    return "&#128993;"  # large yellow circle (pending)


def _event_title(e: SignalEvent) -> str:
    return f"{e.name}\n{e.status.value}\nstart={e.started_at.isoformat()}"


def _parse_run_id(event_name: str) -> Optional[int]:
    # event name format: "wf=<wf> kind=<kind> id=<id> run=<wf_run_id> attempt=<n>"
    try:
        for part in event_name.split():
            if part.startswith("run="):
                return int(part.split("=", 1)[1])
    except Exception:
        return None
    return None


def _commit_min_started_at(
    sha: str, sig_map: Dict[Tuple[str, str], Dict[str, SignalCommit]]
) -> Optional[str]:
    """Return minimal started_at (YYYY-mm-dd HH:MM) across all events for this commit, if any."""
    tmin: Optional[str] = None
    for m in sig_map.values():
        commit = m.get(sha)
        if not commit or not commit.events:
            continue
        # events are sorted oldest first inside SignalCommit
        ts = commit.events[0].started_at.strftime("%Y-%m-%d %H:%M")
        if tmin is None or ts < tmin:
            tmin = ts
    return tmin


def render_html(
    model: GridModel, title: str = "Signal HUD", repo_full_name: str = "pytorch/pytorch"
) -> str:
    # Build fast lookup: (workflow,key)-> {sha: SignalCommit}
    sig_map: Dict[Tuple[str, str], Dict[str, SignalCommit]] = {}
    for col in model.columns:
        m: Dict[str, SignalCommit] = {}
        for c in col.signal.commits:
            m[c.head_sha] = c
        sig_map[(col.workflow_name, col.key)] = m

    # HTML + CSS
    css = """
    body {
        font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial, sans-serif;
        margin: 16px;
    }
    h1 { font-size: 20px; margin-bottom: 12px; }
    .legend { margin: 8px 0 16px; font-size: 13px; }
    .legend span { margin-right: 12px; }
    table { border-collapse: collapse; width: max-content; }
    th, td { border: 1px solid #ddd; padding: 6px 8px; vertical-align: top; }
    th.commit, td.commit {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px; }
    thead th { height: 220px; }
    .col-wrap { height: 200px; position: relative; }
    .col-label { position: absolute; bottom: 4px; left: 4px;
        transform: rotate(-65deg); transform-origin: left bottom; white-space: nowrap; }
    td.cell { text-align: center; font-size: 14px; }
    .ev { margin: 0 2px; display: inline-block; }
    /* simple row highlights */
    .hl-suspected { background: #fff2cc; }
    .hl-baseline { background: #e6f7ff; }
    .hl-newer-fail { background: #fdecea; }
    .hl-restart { outline: 2px dashed #888; }
    .notes { margin-top: 12px; font-size: 12px; }
    """

    html_parts: List[str] = []
    html_parts.append("<!DOCTYPE html>")
    html_parts.append(
        '<html><head><meta charset="utf-8"><title>{}</title>'.format(title)
    )
    html_parts.append(f"<style>{css}</style>")
    html_parts.append("</head><body>")
    html_parts.append(f"<h1>{title}</h1>")
    html_parts.append(
        '<div class="legend">'
        "<span>&#9989; success</span>"
        "<span>&#10060; failure</span>"
        "<span>&#128993; pending</span>"
        "</div>"
    )

    # Table header
    html_parts.append("<table>")
    html_parts.append("<thead><tr>")
    html_parts.append('<th class="commit">Commit (min started_at)</th>')
    for col in model.columns:
        label = f"{col.workflow_name}:{col.key}"
        note = model.column_notes.get((col.workflow_name, col.key))
        title_attr = (note + "\n" if note else "") + label
        html_parts.append(
            f"<th><div class=\"col-wrap\"><div class=\"col-label\" "
            f"title=\"{title_attr.replace('\"', '\'')}\">{label}</div></div></th>"
        )
    html_parts.append("</tr></thead>")

    # Rows
    html_parts.append("<tbody>")
    # Build fast lookup for body rendering
    # (workflow,key) -> {sha -> commit}
    for sha in model.commits:
        classes = " ".join(sorted(model.row_highlights.get(sha, set())))
        html_parts.append(f'<tr class="{classes}">')
        tmin = _commit_min_started_at(sha, sig_map)
        label = f"{sha} {tmin or ''}".strip()
        html_parts.append(f'<td class="commit"><code>{label}</code></td>')
        for col in model.columns:
            commit = sig_map[(col.workflow_name, col.key)].get(sha)
            if not commit or not commit.events:
                html_parts.append('<td class="cell"></td>')
                continue
            cell_parts: List[str] = []
            for e in commit.events:
                icon = _status_icon(e.status)
                title_attr = _event_title(e).replace('"', "'")
                run_id = _parse_run_id(e.name)
                if run_id is not None:
                    url = f"https://github.com/{repo_full_name}/actions/runs/{run_id}"
                    cell_parts.append(
                        f'<a class="ev" href="{url}" title="{title_attr}" target="_blank" '
                        f'rel="noopener noreferrer">{icon}</a>'
                    )
                else:
                    cell_parts.append(
                        f'<span class="ev" title="{title_attr}">{icon}</span>'
                    )
            html_parts.append(f"<td class=\"cell\">{''.join(cell_parts)}</td>")
        html_parts.append("</tr>")
    html_parts.append("</tbody>")
    html_parts.append("</table>")

    # Optional, simple notes block (keeps layout simple)
    if model.column_notes:
        html_parts.append('<div class="notes"><strong>Notes</strong><ul>')
        for col in model.columns:
            note = model.column_notes.get((col.workflow_name, col.key))
            if not note:
                continue
            label = f"{col.workflow_name}:{col.key}"
            html_parts.append(f"<li><code>{label}</code>: {note}</li>")
        html_parts.append("</ul></div>")

    html_parts.append("</body></html>")
    return "".join(html_parts)
