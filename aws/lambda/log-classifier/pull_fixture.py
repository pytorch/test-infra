#!/usr/bin/env python3
"""Pull a real CI log into a log-classifier regression fixture.

Downloads the raw GitHub-Actions log for a failing pytorch/pytorch job, trims it
to a window *centered on the line this repo's classifier surfaces*, and writes it
to ``fixtures/classify/<name>.txt`` as a plain log (timestamps + ANSI intact, no
markers). It then re-blesses via the existing harness
(``UPDATE_FIXTURES=1 cargo test --test classify``), which fills in the in-band
``#=MATCH=#`` / ``‹ ›`` expectation (or leaves no marker when nothing
classifies), and prints where the classifier landed so you can confirm the real
failure made it into the window.

How the default window is found (no HUD / network beyond the log itself): we
write the *whole* log, bless it to see which line the local classifier picks,
then trim to that line +/- --context and bless again. Because the classifier
under test is exactly what runs in prod, its line is what HUD would show, and
centering on it guarantees the classified line is inside the fixture. If the
classifier matches nothing even on the full log, we fall back to the last
``##[error]`` / exit-code line, then to a plain tail.

Input is whatever identifies the job: a bare job id, a GitHub Actions job URL
(``.../actions/runs/<runId>/job/<jobId>``), or the raw-log S3 URL
(``.../log/<jobId>``). Only the trailing job id matters.

Examples::

    # Default: center the window on the classifier's line, then bless.
    ./pull_fixture.py .../actions/runs/30419521715/job/90479820918 --name distributed_fake

    # Keep more confusers around the match.
    ./pull_fixture.py 90479820918 --name distributed_fake --context 120

    # Override the window explicitly (1-based raw line numbers) or by anchor text.
    ./pull_fixture.py 90479820918 --name foo --lines 9220-9340
    ./pull_fixture.py 90479820918 --name foo --grep "should extend from" --context 40

    # Just look: print the numbered full log, write nothing, don't bless.
    ./pull_fixture.py 90479820918 --stdout

Window selection priority: --lines > --grep > --full > (default: classifier
anchor). Line numbers everywhere are 1-based over the raw downloaded log.
"""

from __future__ import annotations

import argparse
import gzip
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path


CRATE_DIR = Path(__file__).resolve().parent
FIXTURE_DIR = CRATE_DIR / "fixtures" / "classify"
S3_HOST = "https://ossci-raw-job-status.s3.amazonaws.com"
MATCH_PREFIX = "#=MATCH=# "
# The failure always precedes the step's exit-code line; a good fallback anchor.
ERROR_ANCHOR = re.compile(r"##\[error\]|Process completed with exit code [1-9]")


def resolve_job_id(arg: str) -> int:
    """Extract the numeric job id from a bare id, a GHA job URL, or a log URL."""
    arg = arg.strip()
    if arg.isdigit():
        return int(arg)
    # ".../job/<id>" (GitHub Actions) or ".../log/<id>" (raw-log S3 URL).
    m = re.search(r"/(?:job|log)/(?:[^/\s]+/)*?(\d+)", arg)
    if m:
        return int(m.group(1))
    sys.exit(
        f"could not find a job id in {arg!r}; pass a bare id, a "
        f".../actions/runs/<run>/job/<id> URL, or a .../log/<id> URL"
    )


def log_url(job_id: int, repo: str) -> str:
    # Mirrors src/network.rs::download_log key scheme.
    key = f"log/{job_id}" if repo == "pytorch/pytorch" else f"log/{repo}/{job_id}"
    return f"{S3_HOST}/{key}"


def _gunzip_maybe(data: bytes) -> bytes:
    """S3 stores these gzipped (Content-Encoding: gzip); decompress if so."""
    return gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data


def download(url: str) -> str:
    """Fetch the raw log. Prefer stdlib urllib; fall back to curl (respects
    corp proxies) so this works across environments."""
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:  # noqa: S310 (trusted host)
            raw = _gunzip_maybe(resp.read())
    except Exception as exc:  # noqa: BLE001 - fall back to curl on any failure
        try:
            raw = _gunzip_maybe(
                subprocess.run(
                    ["curl", "-fsSL", url], check=True, capture_output=True
                ).stdout
            )
        except (OSError, subprocess.CalledProcessError) as curl_exc:
            sys.exit(f"failed to download {url}\n  urllib: {exc}\n  curl:   {curl_exc}")
    return raw.decode("utf-8", errors="replace")


def read_lines(text: str) -> list[str]:
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()  # drop the trailing empty from a final newline
    return lines


def bless() -> None:
    """Run the harness in update mode so it (re)writes the in-band markers."""
    proc = subprocess.run(
        ["cargo", "test", "--test", "classify"],
        cwd=CRATE_DIR,
        env={**os.environ, "UPDATE_FIXTURES": "1"},
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout + proc.stderr)
        sys.exit("bless failed (see cargo output above)")


def marker_of(fixture: Path) -> str | None:
    """The fixture's blessed `#=MATCH=# ...` line, or None if nothing classifies."""
    for line in fixture.read_text().splitlines():
        if line.startswith(MATCH_PREFIX):
            return line
    return None


def match_index(fixture: Path) -> int | None:
    """1-based line number of the `#=MATCH=#` line (== raw log line number when
    the fixture holds the whole log, since bless adds no lines for a match)."""
    for i, line in enumerate(fixture.read_text().splitlines(), start=1):
        if line.startswith(MATCH_PREFIX):
            return i
    return None


def find_error_anchor(lines: list[str]) -> int | None:
    """0-based index of the last error/exit-code line, or None."""
    for i in range(len(lines) - 1, -1, -1):
        if ERROR_ANCHOR.search(lines[i]):
            return i
    return None


def explicit_window(
    lines: list[str], args: argparse.Namespace
) -> tuple[int, int] | None:
    """(start, end) 0-based inclusive for an explicit mode, or None for default."""
    last = len(lines) - 1
    if args.lines:
        m = re.fullmatch(r"(\d+)-(\d+)", args.lines)
        if not m:
            sys.exit(f"--lines expects A-B (1-based), got {args.lines!r}")
        a, b = int(m.group(1)) - 1, int(m.group(2)) - 1
        if a > b:
            sys.exit("--lines A-B requires A <= B")
        return max(0, a), min(last, b)
    if args.grep:
        pat = re.compile(args.grep)
        hits = [i for i, ln in enumerate(lines) if pat.search(ln)]
        if not hits:
            sys.exit(f"--grep {args.grep!r} matched no lines; try --lines or --full")
        return max(0, hits[0] - args.context), min(last, hits[-1] + args.context)
    if args.full:
        return 0, last
    return None


def preview(lines: list[str], start: int, end: int, edge: int = 3) -> str:
    """First/last few window lines (1-based, width-clamped) for a sanity check."""

    def row(i: int) -> str:
        return f"  {i + 1:>7}| {lines[i][:120]}"

    if end - start + 1 <= 2 * edge:
        return "\n".join(row(i) for i in range(start, end + 1))
    return "\n".join(
        [row(i) for i in range(start, start + edge)]
        + [f"  {'...':>7}| ({end - start + 1 - 2 * edge} lines omitted)"]
        + [row(i) for i in range(end - edge + 1, end + 1)]
    )


def write_window(fixture: Path, lines: list[str], start: int, end: int) -> None:
    fixture.write_text("\n".join(lines[start : end + 1]) + "\n")


def report(
    fixture: Path, lines: list[str], start: int, end: int, blessed: bool
) -> None:
    print(
        f"wrote {fixture.relative_to(CRATE_DIR)}  "
        f"(raw lines [{start + 1}..{end + 1}], {end - start + 1} lines)"
    )
    print(preview(lines, start, end))
    if blessed:
        marker = marker_of(fixture)
        if marker is None:
            print("\nclassifier matched nothing -> fixture has no #=MATCH=# line")
            print(
                "\nA failing job the classifier can't classify is usually a ruleset\n"
                "gap, not a real no-match. Confirm that's intended; if not, pin the\n"
                "window with --grep / --lines so the real failure is in view."
            )
        else:
            print(f"\nclassifier landed on:\n  {marker}")
            print(
                "\nConfirm this is the *real* failure. If the real cause is missing,\n"
                "re-run with a larger --context, or pin it with --grep / --lines."
            )
    else:
        print(
            "\nnext: UPDATE_FIXTURES=1 cargo test --test classify   # bless the marker"
        )


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("job", help="job id, GHA job URL, or raw-log URL")
    p.add_argument("--name", help="fixture name (default: job_<id>); .txt optional")
    p.add_argument(
        "--repo",
        default="pytorch/pytorch",
        help="owner/repo (default: pytorch/pytorch)",
    )
    win = p.add_argument_group(
        "window (priority: --lines > --grep > --full > classifier anchor)"
    )
    win.add_argument(
        "--context",
        type=int,
        default=60,
        metavar="N",
        help="lines kept on each side of the anchor (default: 60)",
    )
    win.add_argument(
        "--tail",
        type=int,
        default=250,
        metavar="N",
        help="lines before the anchor in the error-line/tail fallback (default: 250)",
    )
    win.add_argument(
        "--grep", metavar="REGEX", help="anchor the window on lines matching REGEX"
    )
    win.add_argument("--lines", metavar="A-B", help="exact 1-based raw line range")
    win.add_argument("--full", action="store_true", help="keep the entire log")
    p.add_argument(
        "--stdout",
        action="store_true",
        help="print the numbered full log and exit (write nothing, don't bless)",
    )
    p.add_argument(
        "--no-bless",
        action="store_true",
        help="write the fixture but skip cargo; forces the offline error-line/tail anchor",
    )
    args = p.parse_args()

    job_id = resolve_job_id(args.job)
    url = log_url(job_id, args.repo)
    lines = read_lines(download(url))
    if not lines:
        sys.exit(f"log for job {job_id} is empty")
    print(f"job {job_id}: {len(lines)} lines  ({url})")

    if args.stdout:
        win = explicit_window(lines, args) or (0, len(lines) - 1)
        for i in range(win[0], win[1] + 1):
            print(f"{i + 1}\t{lines[i]}")
        return

    name = (args.name or f"job_{job_id}").removesuffix(".txt")
    fixture = FIXTURE_DIR / f"{name}.txt"
    last = len(lines) - 1

    win = explicit_window(lines, args)
    if win is not None:
        # Explicit window: write once, bless once.
        write_window(fixture, lines, *win)
        if not args.no_bless:
            bless()
        report(fixture, lines, *win, blessed=not args.no_bless)
    elif args.no_bless:
        # Offline default: can't ask the classifier, so anchor on the last error.
        a = find_error_anchor(lines)
        if a is None:
            start, end = max(0, len(lines) - args.tail), last
            print("no error line found; falling back to a plain tail")
        else:
            # The failure precedes the exit-code line; end just past it so the
            # trailing teardown stays out of the window.
            start, end = max(0, a - args.tail), min(last, a + args.context)
            print(f"error-line anchor at raw line {a + 1} (offline; --no-bless)")
        write_window(fixture, lines, start, end)
        report(fixture, lines, start, end, blessed=False)
    else:
        # Default: bless the whole log to find the classifier's line, then trim.
        print("locating the classifier's match on the full log...")
        write_window(fixture, lines, 0, last)
        bless()
        idx = match_index(fixture)  # 1-based raw line number, or None
        if idx is not None:
            a = idx - 1
            start = max(0, a - args.context)
            end = min(last, a + args.context)
            print(f"classifier anchor at raw line {idx}; window +/-{args.context}")
        else:
            a = find_error_anchor(lines)
            if a is None:
                start, end = max(0, len(lines) - args.tail), last
                print("classifier matched nothing; falling back to a plain tail")
            else:
                start, end = max(0, a - args.tail), min(last, a + args.context)
                print(f"classifier matched nothing; anchoring on error line {a + 1}")
        write_window(fixture, lines, start, end)
        bless()  # re-annotate on the trimmed window
        report(fixture, lines, start, end, blessed=True)

    if not args.name:
        print(f"\ntip: rename {name}.txt descriptively and record it in FIXTURES.md")


if __name__ == "__main__":
    main()
