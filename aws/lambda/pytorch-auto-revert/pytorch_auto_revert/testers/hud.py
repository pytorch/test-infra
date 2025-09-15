import logging
from typing import Iterable, Optional

from ..hud_renderer import build_grid_model, render_html
from ..signal_extraction import SignalExtractor


def run_hud(
    workflows: Iterable[str],
    *,
    hours: int = 24,
    repo_full_name: str = "pytorch/pytorch",
    out: str = "hud.html",
    ignore_newer_than: Optional[str] = None,
) -> str:
    """
    Extracts signals for the given workflows, optionally truncates commit history
    to ignore commits newer than a specific SHA, builds a HUD model, and writes
    an HTML report to `out`.

    Returns the output filepath.
    """

    logging.info(
        "[hud] Start: workflows=%s hours=%s repo=%s",
        ",".join(workflows),
        hours,
        repo_full_name,
    )

    extractor = SignalExtractor(
        workflows=workflows,
        lookback_hours=hours,
        repo_full_name=repo_full_name,
    )
    logging.info("[hud] Extracting signals ...")
    signals = extractor.extract()
    logging.info("[hud] Extracted %d signals", len(signals))

    # Optionally cut off newest commits above a given commit SHA prefix
    if ignore_newer_than:
        cut_prefix = str(ignore_newer_than).strip()
        if cut_prefix:
            total_trimmed = 0
            found_any = False
            for s in signals:
                # commits are ordered newest -> older; find first index that matches prefix
                idx = next(
                    (
                        i
                        for i, c in enumerate(s.commits)
                        if c.head_sha.startswith(cut_prefix)
                    ),
                    None,
                )
                if idx is None:
                    continue
                found_any = True
                trimmed = idx  # number of newer commits dropped
                if trimmed > 0:
                    total_trimmed += trimmed
                    s.commits = s.commits[idx:]
            if not found_any:
                logging.warning(
                    "[hud] ignore-newer-than='%s' did not match any commit in extracted signals",
                    cut_prefix,
                )
            else:
                logging.info(
                    "[hud] Applied ignore-newer-than=%s; dropped %d newer commit entries across signals",
                    cut_prefix,
                    total_trimmed,
                )

    logging.info("[hud] Building grid model ...")
    model = build_grid_model(signals)
    logging.info(
        "[hud] Model: %d commits, %d columns",
        len(model.commits),
        len(model.columns),
    )

    logging.info("[hud] Rendering HTML ...")
    html = render_html(
        model,
        title=f"Signal HUD: {', '.join(workflows)} ({hours}h)",
        repo_full_name=repo_full_name,
    )
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    logging.info("[hud] HUD written to %s", out)
    logging.info("HUD written to %s", out)

    return out
