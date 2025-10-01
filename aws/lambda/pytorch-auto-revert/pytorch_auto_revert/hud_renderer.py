from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Dict, List, Mapping, Optional, Sequence, Union

from .signal import SignalStatus
from .utils import build_pytorch_hud_url


HUD_CSS = """
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
    .hl-suspected { background: #ffd0d0; }
    .hl-baseline { background: #e6f7ff; }
    .hl-newer-fail { background: #fdecea; }
    .hl-restart { outline: 2px dashed #888; }
    .notes { margin-top: 12px; font-size: 12px; }
    /* outcome badges and expanders */
    .outcome { text-align: center; vertical-align: top; cursor: pointer; min-width: 80px; }
    .badge { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 11px;
     font-weight: 600; border: 1px solid transparent; }
    .badge-revert { background: #fee; color: #a40000; border-color: #f8b4b4; }
    .badge-restart { background: #fff3bf; color: #7a5a00; border-color: #ffe08a; }
    .badge-ineligible { background: #eee; color: #555; border-color: #ccc; }
    .outcome .details { display: none; margin-top: 6px;
        background: #fafafa; border: 1px solid #ddd; padding: 6px; text-align: left; font-size: 12px; }
    .outcome.open .details { display: block; }
    .outcome .close { float: right; cursor: pointer; color: #666; }
    /* apply highlights to individual cells */
    td.cell.hl-suspected { background: #ffd0d0; }
    td.cell.hl-baseline { background: #e6f7ff; }
    td.cell.hl-newer-fail { background: #fdecea; }
    td.cell.hl-restart { outline: 2px dashed #888; outline-offset: -2px; }
"""

HUD_JS = (
    "<script>\n"
    "let __openOutcome = null;\n"
    "function toggleOutcome(id){\n"
    "  const el = document.getElementById(id);\n"
    "  if(!el) return;\n"
    "  if(__openOutcome && __openOutcome !== id){\n"
    "    const prev = document.getElementById(__openOutcome);\n"
    "    if(prev) prev.classList.remove('open');\n"
    "    __openOutcome = null;\n"
    "  }\n"
    "  const willOpen = !el.classList.contains('open');\n"
    "  el.classList.toggle('open');\n"
    "  __openOutcome = willOpen ? id : null;\n"
    "}\n"
    "</script>"
)


def _status_icon(status: Union[SignalStatus, str]) -> str:
    value = status.value if isinstance(status, SignalStatus) else str(status).lower()
    if value == SignalStatus.FAILURE.value:
        return "&#10060;"  # cross mark
    if value == SignalStatus.SUCCESS.value:
        return "&#9989;"  # check mark button
    return "&#128993;"  # large yellow circle (pending)


def _parse_run_id(event_name: str) -> Optional[int]:
    # event name format: "wf=<wf> kind=<kind> id=<id> run=<wf_run_id> attempt=<n>"
    try:
        for part in event_name.split():
            if part.startswith("run="):
                return int(part.split("=", 1)[1])
    except Exception:
        return None
    return None


def _format_commit_label_from_state(sha: str, commit_times: Mapping[str, Any]) -> str:
    raw = commit_times.get(sha)
    if raw is None:
        return sha
    text = str(raw)
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        text = dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        # keep original text if parsing fails
        pass
    return f"{sha} {text}".strip()


def _event_title_from_dict(event: Mapping[str, Any]) -> str:
    parts: List[str] = []
    name = event.get("name")
    if name:
        parts.append(str(name))
    status = event.get("status")
    if status:
        parts.append(str(status))
    start = event.get("started_at")
    if start:
        parts.append(f"start={start}")
    end = event.get("ended_at")
    if end:
        parts.append(f"end={end}")
    return "\n".join(parts)


def _legacy_outcomes_from_columns(
    columns: Sequence[Mapping[str, Any]], commits: Sequence[str]
) -> Dict[str, Dict[str, Any]]:
    mapping: Dict[str, Dict[str, Any]] = {}
    commit_index = {sha: idx for idx, sha in enumerate(commits)}

    def _resolve(prefix: Optional[str]) -> Optional[str]:
        if not prefix:
            return None
        prefix = prefix.strip()
        if not prefix:
            return None
        for sha in commits:
            if sha.startswith(prefix):
                return sha
        return prefix

    def _sig_key(col: Mapping[str, Any]) -> str:
        workflow = str(col.get("workflow", ""))
        key = str(col.get("key", ""))
        return f"{workflow}:{key}" if key else workflow

    for col in columns:
        sig = _sig_key(col)
        outcome = str(col.get("outcome", "ineligible"))
        highlights: Mapping[str, Sequence[str]] = col.get("highlights", {}) or {}
        note = str(col.get("note", ""))
        cells: Mapping[str, Sequence[Mapping[str, Any]]] = col.get("cells", {}) or {}

        def _has_status(sha: str, status: str, _cells=cells) -> bool:
            return any(ev.get("status") == status for ev in _cells.get(sha, []) or [])

        if outcome == "revert":
            suspected = next(
                (
                    sha
                    for sha, classes in highlights.items()
                    if "hl-suspected" in classes
                ),
                None,
            )
            baseline = next(
                (
                    sha
                    for sha, classes in highlights.items()
                    if "hl-baseline" in classes
                ),
                None,
            )
            newer = [
                sha for sha, classes in highlights.items() if "hl-newer-fail" in classes
            ]
            if not suspected:
                m = re.search(r"suspect\s+([0-9a-fA-F]{6,40})", note)
                suspected = _resolve(m.group(1) if m else None)
            if not baseline:
                m = re.search(r"baseline\s+([0-9a-fA-F]{6,40})", note)
                baseline = _resolve(m.group(1) if m else None)

            failed_commits = [sha for sha in commits if _has_status(sha, "failure")]
            if not suspected and failed_commits:
                # suspect is the oldest failing commit (last in list since commits newest->older)
                suspected = failed_commits[-1]
            if not newer and failed_commits:
                newer = [sha for sha in failed_commits if sha != suspected]
            if not baseline and suspected and suspected in commit_index:
                for sha in commits[commit_index[suspected] + 1 :]:
                    if _has_status(sha, "success"):
                        baseline = sha
                        break
            newer = [sha for sha in newer if sha]
            newer.sort(key=lambda sha: commit_index.get(sha, float("inf")))
            mapping[sig] = {
                "type": "AutorevertPattern",
                "data": {
                    "suspected_commit": suspected,
                    "older_successful_commit": baseline,
                    "newer_failing_commits": newer,
                },
            }
        elif outcome == "restart":
            restart_shas = sorted(
                sha for sha, classes in highlights.items() if "hl-restart" in classes
            )
            if not restart_shas:
                restart_shas = [
                    _resolve(match)
                    for match in re.findall(r"([0-9a-fA-F]{6,40})", note)
                ]
                restart_shas = [sha for sha in restart_shas if sha]
            if not restart_shas:
                # fall back to commits that had failures but not marked success
                restart_shas = [sha for sha in commits if _has_status(sha, "failure")]
            seen: List[str] = []
            for sha in restart_shas:
                if sha and sha not in seen:
                    seen.append(sha)
            restart_shas = sorted(
                seen, key=lambda sha: commit_index.get(sha, float("inf"))
            )
            mapping[sig] = {
                "type": "RestartCommits",
                "data": {"commit_shas": restart_shas},
            }
        else:
            ineligible = col.get("ineligible", {}) or {}
            reason = ineligible.get("reason")
            message = ineligible.get("message")
            if not reason and note:
                m = re.search(r"Ineligible:\s*([^\u2014]+)", note)
                if m:
                    reason = m.group(1).strip()
            if not message and "—" in note:
                message = note.split("—", 1)[1].strip()
            mapping[sig] = {
                "type": "Ineligible",
                "data": {
                    "reason": reason,
                    "message": message,
                },
            }
    return mapping


def _highlights_from_outcome(outcome: Mapping[str, Any]) -> Dict[str, List[str]]:
    res: Dict[str, List[str]] = {}
    if not outcome:
        return res
    outcome_type = outcome.get("type")
    data = (
        outcome.get("data", {}) if isinstance(outcome.get("data"), Mapping) else outcome
    )
    if outcome_type == "AutorevertPattern":
        for sha in data.get("newer_failing_commits", []) or []:
            if sha:
                res.setdefault(sha, []).append("hl-newer-fail")
        suspected = data.get("suspected_commit")
        if suspected:
            res.setdefault(suspected, []).append("hl-suspected")
        baseline = data.get("older_successful_commit")
        if baseline:
            res.setdefault(baseline, []).append("hl-baseline")
    elif outcome_type == "RestartCommits":
        for sha in data.get("commit_shas", []) or []:
            if sha:
                res.setdefault(sha, []).append("hl-restart")
    return res


def _note_from_outcome(outcome: Optional[Mapping[str, Any]]) -> str:
    if not outcome:
        return ""
    outcome_type = outcome.get("type")
    data = (
        outcome.get("data", {}) if isinstance(outcome.get("data"), Mapping) else outcome
    )
    if outcome_type == "AutorevertPattern":
        newer = data.get("newer_failing_commits", []) or []
        suspected = data.get("suspected_commit") or "?"
        baseline = data.get("older_successful_commit") or "?"
        return (
            f"Pattern: newer fail {len(newer)}; suspect {suspected[:7]}"
            f" vs baseline {baseline[:7]}"
        )
    if outcome_type == "RestartCommits":
        commits = data.get("commit_shas", []) or []
        if commits:
            short = ", ".join(sorted(sha[:7] for sha in commits if sha))
        else:
            short = "<none>"
        return f"Suggest restart: {short}"
    if outcome_type == "Ineligible":
        reason = data.get("reason") or ""
        message = data.get("message") or ""
        base = f"Ineligible: {reason}" if reason else "Ineligible"
        if message:
            base += f" — {message}"
        return base
    return ""


def render_html_from_state(
    state: Mapping[str, Any], title: Optional[str] = None
) -> str:
    commits: Sequence[str] = state.get("commits", []) or []
    commit_times: Mapping[str, Any] = state.get("commit_times", {}) or {}
    columns: Sequence[Mapping[str, Any]] = state.get("columns", []) or []
    meta: Mapping[str, Any] = state.get("meta", {}) or {}

    raw_outcomes = (
        state.get("outcomes") if isinstance(state.get("outcomes"), dict) else None
    )
    if raw_outcomes:
        outcome_map = {str(k): v for k, v in raw_outcomes.items()}
    else:
        outcome_map = _legacy_outcomes_from_columns(columns, commits)

    highlight_lookup: Dict[str, Dict[str, List[str]]] = {
        key: _highlights_from_outcome(value) for key, value in outcome_map.items()
    }

    repo_full_name = str(meta.get("repo") or "pytorch/pytorch")
    workflows_meta = meta.get("workflows", []) or []
    if isinstance(workflows_meta, str):
        workflows_label = workflows_meta
    else:
        workflows_label = ", ".join(str(w) for w in workflows_meta)
    lookback = meta.get("lookback_hours")
    if title is None:
        hours_part = ""
        if isinstance(lookback, (int, float)):
            hours_part = f" ({int(lookback)}h)"
        display_label = workflows_label or repo_full_name
        title = f"Signal HUD: {display_label}{hours_part}"

    html_parts: List[str] = []
    html_parts.append("<!DOCTYPE html>")
    html_parts.append(
        '<html><head><meta charset="utf-8"><title>{}</title>'.format(title)
    )
    html_parts.append(f"<style>{HUD_CSS}</style>")
    html_parts.append(HUD_JS)
    html_parts.append("</head><body>")
    html_parts.append(f"<h1>{title}</h1>")
    html_parts.append(
        '<div class="legend">'
        "<span>&#9989; success</span>"
        "<span>&#10060; failure</span>"
        "<span>&#128993; pending</span>"
        "</div>"
    )

    html_parts.append("<table>")
    html_parts.append("<thead>")
    html_parts.append("<tr>")
    html_parts.append('<th class="commit">Commit (min started_at)</th>')
    for col in columns:
        workflow = str(col.get("workflow", ""))
        key = str(col.get("key", ""))
        label = f"{workflow}:{key}" if key else workflow
        note = str(col.get("note", ""))
        title_attr = (note + "\n" if note else "") + label
        safe_title = title_attr.replace('"', "'")
        html_parts.append(
            f'<th><div class="col-wrap"><div class="col-label" '
            f'title="{safe_title}">{label}</div></div></th>'
        )
    html_parts.append("</tr>")

    html_parts.append("<tr>")
    html_parts.append('<th class="commit">Outcome</th>')
    for idx, col in enumerate(columns):
        outcome = str(col.get("outcome", "ineligible"))
        workflow = str(col.get("workflow", ""))
        key = str(col.get("key", ""))
        sig_key = f"{workflow}:{key}" if key else workflow
        note = _note_from_outcome(outcome_map.get(sig_key))
        if not note:
            note = str(col.get("note", ""))
        rid = f"oc-{idx}"
        if outcome == "revert":
            badge = '<span class="badge badge-revert">REV</span>'
        elif outcome == "restart":
            badge = '<span class="badge badge-restart">RST</span>'
        else:
            badge = '<span class="badge badge-ineligible">N/A</span>'
        header_label = f"{workflow}:{key}" if key else workflow
        safe_note = note.replace('"', "'")

        # Build PyTorch HUD dashboard link if job_base_name is available
        hud_link = ""
        job_base_name = col.get("job_base_name")
        if job_base_name and commits:
            # Top commit (most recent)
            top_sha = commits[0]
            num_commits = len(commits)
            hud_url = build_pytorch_hud_url(
                repo_full_name=repo_full_name,
                top_sha=top_sha,
                num_commits=num_commits,
                job_base_name=job_base_name,
            )
            hud_link = (
                f'<div><a href="{hud_url}" target="_blank" '
                f'rel="noopener noreferrer">View in PyTorch HUD →</a></div>'
            )

        html_parts.append(
            f'<th id="{rid}" class="outcome" onclick="toggleOutcome(\'{rid}\')" '
            f'title="Click to expand">{badge}'
            f'<div class="details"><span class="close" '
            f"onclick=\"toggleOutcome('{rid}'); event.stopPropagation();\">×</span>"
            f"<div><strong>{header_label}</strong></div>"
            f"<div>{safe_note}</div>"
            f"{hud_link}"
            "</div>"
            "</th>"
        )
    html_parts.append("</tr>")
    html_parts.append("</thead>")

    html_parts.append("<tbody>")
    for sha in commits:
        html_parts.append("<tr>")
        label = _format_commit_label_from_state(sha, commit_times)
        html_parts.append(f'<td class="commit"><code>{label}</code></td>')
        for col in columns:
            cells_map = col.get("cells", {}) or {}
            events = cells_map.get(sha, []) or []
            workflow = str(col.get("workflow", ""))
            key = str(col.get("key", ""))
            sig_key = f"{workflow}:{key}" if key else workflow
            highlights_map = highlight_lookup.get(sig_key, {})
            cell_classes = " ".join(sorted(highlights_map.get(sha, [])))
            if not events:
                html_parts.append(f'<td class="cell {cell_classes}"></td>')
                continue

            cell_parts: List[str] = []
            for event in events:
                status = event.get("status", "")
                icon = _status_icon(status)
                title_attr = _event_title_from_dict(event).replace('"', "'")

                # Prefer job_id if available, otherwise fall back to parsing run_id from name
                job_id = event.get("job_id")
                run_id = _parse_run_id(str(event.get("name", "")))

                if job_id is not None and run_id is not None:
                    # Link directly to the specific job
                    url = f"https://github.com/{repo_full_name}/actions/runs/{run_id}/job/{job_id}"
                    cell_parts.append(
                        f'<a class="ev" href="{url}" title="{title_attr}" '
                        f'target="_blank" rel="noopener noreferrer">{icon}</a>'
                    )
                elif run_id is not None:
                    # Link to workflow run (no job_id available)
                    url = f"https://github.com/{repo_full_name}/actions/runs/{run_id}"
                    cell_parts.append(
                        f'<a class="ev" href="{url}" title="{title_attr}" '
                        f'target="_blank" rel="noopener noreferrer">{icon}</a>'
                    )
                else:
                    cell_parts.append(
                        f'<span class="ev" title="{title_attr}">{icon}</span>'
                    )
            html_parts.append(
                f"<td class=\"cell {cell_classes}\">{''.join(cell_parts)}</td>"
            )
        html_parts.append("</tr>")
    html_parts.append("</tbody>")
    html_parts.append("</table>")
    html_parts.append("</body></html>")
    return "".join(html_parts)
