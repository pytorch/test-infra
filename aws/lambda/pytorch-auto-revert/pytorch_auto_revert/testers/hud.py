import json
import logging
from typing import Any, Mapping, Optional, Union

from ..hud_renderer import render_html_from_state
from ..signal_extraction_datasource import SignalExtractionDatasource


RunStatePayload = Union[str, Mapping[str, Any]]


def _ensure_state_dict(state: RunStatePayload) -> Mapping[str, Any]:
    if isinstance(state, str):
        return json.loads(state)
    return state


def write_hud_html(state: RunStatePayload, out_path: str) -> str:
    """Render the given run-state JSON (string or mapping) to HUD HTML."""
    state_dict = _ensure_state_dict(state)
    meta = state_dict.get("meta", {})
    workflows = meta.get("workflows") or []
    lookback = meta.get("lookback_hours")
    logging.info(
        "[hud] Rendering HTML for repo=%s workflows=%s lookback=%s → %s",
        meta.get("repo"),
        ",".join(workflows) if isinstance(workflows, list) else workflows,
        lookback,
        out_path,
    )
    html = render_html_from_state(state_dict)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    logging.info("HUD written to %s", out_path)
    return out_path


def render_hud_html_from_clickhouse(
    timestamp: str,
    *,
    repo_full_name: Optional[str] = None,
    out_path: str,
) -> str:
    """Fetch a logged autorevert state from ClickHouse by timestamp and render HUD HTML."""

    logging.info(
        "[hud] Fetching run state ts=%s repo=%s",
        timestamp,
        repo_full_name or "<any>",
    )
    rows = SignalExtractionDatasource().fetch_autorevert_state_rows(
        ts=timestamp, repo_full_name=repo_full_name
    )
    if not rows:
        raise RuntimeError(
            "No autorevert_state row found for ts="
            + timestamp
            + (" repo=" + repo_full_name if repo_full_name else "")
        )
    if len(rows) > 1:
        raise RuntimeError(
            "Multiple autorevert_state rows found for ts="
            + timestamp
            + "; pass --repo-full-name to disambiguate"
        )

    row = rows[0]
    repo = row["repo"]
    workflows = row["workflows"]
    state_json = row["state"]
    if isinstance(workflows, str):
        workflows_display = workflows
    else:
        workflows_display = ",".join(workflows or [])
    logging.info("[hud] Loaded state for repo=%s workflows=%s", repo, workflows_display)
    return write_hud_html(state_json, out_path)
