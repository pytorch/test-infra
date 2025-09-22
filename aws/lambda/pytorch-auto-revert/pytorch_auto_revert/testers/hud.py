import json
import logging
import re
from typing import Any, Mapping, Optional, Union

from ..hud_renderer import render_html_from_state
from ..signal_extraction_datasource import SignalExtractionDatasource


RunStatePayload = Union[str, Mapping[str, Any]]


def _ensure_state_dict(state: RunStatePayload) -> Mapping[str, Any]:
    if isinstance(state, str):
        return json.loads(state)
    return state


def get_state_timestamp(state: RunStatePayload) -> str:
    """Extract the run timestamp embedded in the HUD state payload."""
    state_dict = _ensure_state_dict(state)
    meta = state_dict.get("meta", {})
    ts = meta.get("ts")
    if not ts:
        raise ValueError("State payload is missing meta.ts")
    return str(ts)


def default_hud_filename(timestamp: str) -> str:
    """Produce a filesystem-friendly HUD filename for the given timestamp."""
    # Replace separators that are invalid on some filesystems (e.g. Windows).
    sanitized = timestamp.strip().replace(" ", "_").replace(":", "-")
    # Whitelist characters to minimize surprises.
    sanitized = re.sub(r"[^A-Za-z0-9._-]", "-", sanitized)
    if not sanitized:
        raise ValueError("Timestamp did not produce a usable filename")
    return f"{sanitized}.html"


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
    timestamp: Optional[str],
    *,
    repo_full_name: Optional[str] = None,
    out_path: Optional[str] = None,
) -> str:
    """Fetch a logged autorevert state from ClickHouse and render HUD HTML.

    If ``timestamp`` is ``None``, the latest non-dry-run state is used.
    When ``out_path`` is ``None``, the filename defaults to the resolved timestamp.
    """

    datasource = SignalExtractionDatasource()
    resolved_ts = timestamp
    if resolved_ts is None:
        resolved_ts = datasource.fetch_latest_non_dry_run_timestamp(
            repo_full_name=repo_full_name
        )
        if resolved_ts is None:
            raise RuntimeError(
                "No non-dry-run autorevert_state rows available for HUD rendering"
            )

    logging.info(
        "[hud] Fetching run state ts=%s repo=%s",
        resolved_ts,
        repo_full_name or "<any>",
    )
    rows = datasource.fetch_autorevert_state_rows(
        ts=resolved_ts, repo_full_name=repo_full_name
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
    final_out_path = out_path or default_hud_filename(resolved_ts)
    logging.info("[hud] Loaded state for repo=%s workflows=%s", repo, workflows_display)
    return write_hud_html(state_json, final_out_path)
