#!/usr/bin/env python3
"""Snapshot current nightly PyTorch wheel sizes into a JSON file keyed by a
date/version-invariant wheel key, for day-over-day size-regression detection.

Reuses ``parse_index`` / ``get_binary_size`` from ``binary_size_validation.py``.

Example:
    python nightly_wheel_snapshot.py --out today.json
"""

import argparse
import json
import re
import sys
from typing import Optional

import requests
from binary_size_validation import get_binary_size, parse_index

# Nightly index URLs to snapshot. Extend as CUDA/ROCm variants change; the
# delta step matches wheels across days by the version-invariant key below, so
# adding/removing a URL only changes coverage, not comparability.
DEFAULT_URLS = [
    "https://download.pytorch.org/whl/nightly/cpu/torch/",
    "https://download.pytorch.org/whl/nightly/cu128/torch/",
    "https://download.pytorch.org/whl/nightly/cu130/torch/",
]

# torch-2.9.0.dev20260714+cu128-cp312-cp312-manylinux_2_28_x86_64.whl
_WHEEL_RE = re.compile(
    r"^(?P<pkg>[A-Za-z0-9_.]+)-(?P<ver>[^-]+)-(?P<py>[^-]+)-(?P<abi>[^-]+)-(?P<plat>.+)\.whl$"
)


def wheel_key(name: str) -> Optional[str]:
    """Return a version/date-invariant key for a wheel filename, or None.

    The base version + nightly date + git hash change every day, so they are
    dropped; the local variant (``+cu128`` / ``+rocm6.4`` / ``+cpu``) and the
    python/abi/platform tags are kept. This makes the same logical wheel
    comparable across daily snapshots.

    torch-2.9.0.dev20260714+cu128-cp312-cp312-manylinux_2_28_x86_64.whl
        -> torch+cu128-cp312-cp312-manylinux_2_28_x86_64
    """
    m = _WHEEL_RE.match(name)
    if not m:
        return None
    ver = m.group("ver")
    local = ver.split("+", 1)[1] if "+" in ver else "cpu"
    return f"{m.group('pkg')}+{local}-{m.group('py')}-{m.group('abi')}-{m.group('plat')}"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--url",
        action="append",
        default=None,
        help="nightly index URL (repeatable); defaults to a standard variant set",
    )
    ap.add_argument(
        "--include",
        default="manylinux",
        help="include-regex passed to parse_index (default: manylinux)",
    )
    ap.add_argument("--out", required=True, help="output JSON path")
    args = ap.parse_args()

    urls = args.url or DEFAULT_URLS
    snapshot: dict[str, dict] = {}
    for url in urls:
        try:
            page = requests.get(url, timeout=60)
            page.raise_for_status()
        except Exception as e:  # noqa: BLE001 — skip an unavailable variant, keep going
            print(f"WARN: failed to fetch {url}: {e}", file=sys.stderr)
            continue
        wheels = parse_index(
            page.text, url, include_regex=args.include, latest_version_only=True
        )
        for w in wheels:
            key = wheel_key(w.name)
            if not key:
                print(f"WARN: unparseable wheel name {w.name}", file=sys.stderr)
                continue
            try:
                size = get_binary_size(w.url)
            except Exception as e:  # noqa: BLE001
                print(f"WARN: size fetch failed {w.url}: {e}", file=sys.stderr)
                continue
            snapshot[key] = {"bytes": size, "name": w.name, "url": w.url}

    with open(args.out, "w") as f:
        json.dump(snapshot, f, indent=2, sort_keys=True)
    print(f"Wrote {len(snapshot)} wheel sizes to {args.out}")


if __name__ == "__main__":
    main()
