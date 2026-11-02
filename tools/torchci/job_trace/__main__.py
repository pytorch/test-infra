"""Write a Perfetto trace of CI test jobs from ci.runs. See README.md."""

from __future__ import annotations

import argparse
import gzip
import http.server
import json
import os
import sys
import time
import webbrowser
from typing import Any, Dict, List, Optional

from torchci.job_trace.query import fetch
from torchci.job_trace.trace import build_trace


PERFETTO_UI = "https://ui.perfetto.dev"
# The local port the Perfetto UI may fetch traces from.
PORT = 9001


def write_trace(trace: Dict[str, Any], path: str) -> None:
    opener: Any = gzip.open if path.endswith(".gz") else open
    with opener(path, "wt", encoding="utf-8") as f:
        json.dump(trace, f, separators=(",", ":"))


def open_in_perfetto(path: str, wait_s: float = 300) -> None:
    """Serve path once on 127.0.0.1 and open it in the Perfetto UI. The trace
    stays on this machine; the UI's share button would upload it."""
    name = os.path.basename(path)
    directory = os.path.dirname(os.path.abspath(path))
    served: List[bool] = []

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, directory=directory, **kwargs)

        def end_headers(self) -> None:
            self.send_header("Access-Control-Allow-Origin", PERFETTO_UI)
            super().end_headers()

        def do_GET(self) -> None:
            # Serve only the trace, not the rest of its directory.
            if self.path != "/" + name:
                self.send_error(404)
                return
            super().do_GET()
            served.append(True)

    server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
    server.timeout = 1
    webbrowser.open(f"{PERFETTO_UI}/#!/?url=http://127.0.0.1:{PORT}/{name}")
    deadline = time.monotonic() + wait_s
    while not served and time.monotonic() < deadline:
        server.handle_request()
    server.server_close()
    if not served:
        print(
            f"{PERFETTO_UI} did not fetch the trace; open {path} there instead",
            file=sys.stderr,
        )


def main(argv: Optional[List[str]] = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "job_ids", nargs="+", type=int, help="workflow job ids, separated by spaces"
    )
    parser.add_argument(
        "-o",
        "--output",
        help="output path, gzipped if it ends in .gz (default: job_<id>.json)",
    )
    parser.add_argument(
        "--owner",
        default="",
        help="keep only files ci.owners gives this owner, e.g. inductor",
    )
    parser.add_argument(
        "--open", action="store_true", help="open the trace in ui.perfetto.dev"
    )
    args = parser.parse_args(argv)

    job_rows, run_rows = fetch(args.job_ids, args.owner)
    trace, stats = build_trace(args.job_ids, job_rows, run_rows)
    output = args.output or f"job_{args.job_ids[0]}.json"
    write_trace(trace, output)

    for job_id, s in stats.items():
        of_step = (
            f" of a {s.test_step_minutes:.0f} min Test step"
            if s.test_step_minutes
            else ""
        )
        note = (
            ""
            if s.runs
            else " (no runs: older than 14 days, no reports, or no files of --owner)"
        )
        print(
            f"{job_id}: {s.runs} runs, {s.reports} reports, {s.lanes} lanes, "
            f"{s.test_minutes:.1f} min in test processes{of_step}{note}",
            file=sys.stderr,
        )
    print(f"wrote {output} ({os.path.getsize(output) / 1e6:.1f} MB)", file=sys.stderr)
    if args.open:
        open_in_perfetto(output)


if __name__ == "__main__":
    main()
