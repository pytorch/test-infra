#!/usr/bin/env python3
"""
Markdown preview of the binaries a promotion from whl/test to whl/ would copy.

Reads the package's published index on the test channel, which is public, so it
runs in a job that has no AWS credentials. The promote job lists the exact S3
objects again right before it copies them; this is for the reviewer who has to
approve it.

Usage: preview_promotion.py <package> <version> [skip_targets]
  skip_targets: comma-separated accelerator folders left out, e.g. "cu130".
                Matches the <target>/ folder and the "+<target>" local version
                in the file name, like PACKAGE_EXCLUDE_TARGETS in
                release/promote/common_utils.sh.
"""

import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict

CHANNEL = "https://download.pytorch.org/whl/test"


def index_url(package):
    # PEP 503 name normalisation: torch_tensorrt -> torch-tensorrt.
    return f"{CHANNEL}/{re.sub(r'[-_.]+', '-', package).lower()}/"


def list_binaries(package, version, html):
    """(folder, filename) of every file the s3 include pattern would match."""
    found = set()
    for href in re.findall(r'href="([^"#]+)(?:#[^"]*)?"', html):
        path = urllib.parse.unquote(urllib.parse.urlparse(href).path)
        folder, _, name = path.rpartition("/")
        # "*{package}-{version}*" in aws_promote
        if not name.startswith(f"{package}-{version}"):
            continue
        folder = folder.removeprefix("/whl/test").strip("/")
        found.add((folder, name))
    return sorted(found)


def is_skipped(folder, name, targets):
    return any(folder == t or f"+{t}-" in name for t in targets)


def render(package, version, targets, binaries):
    promoted = [b for b in binaries if not is_skipped(*b, targets)]
    skipped = [b for b in binaries if is_skipped(*b, targets)]

    out = [f"### Binaries to promote: `{package}` {version}", ""]
    out.append(f"Skipped targets: {', '.join(f'`{t}`' for t in targets) or 'none'}")
    out.append("")
    out.append(f"**{len(promoted)} to promote**, {len(skipped)} skipped.")
    out.append("")

    counts = defaultdict(lambda: [0, 0])
    for folder, _ in promoted:
        counts[folder][0] += 1
    for folder, _ in skipped:
        counts[folder][1] += 1
    out += ["| Folder | Promoted | Skipped |", "|---|---|---|"]
    for folder in sorted(counts):
        label = f"`{folder}/`" if folder else "(channel root)"
        out.append(f"| {label} | {counts[folder][0]} | {counts[folder][1]} |")
    out.append("")

    out.append(f"<details><summary>All {len(promoted)} binaries to promote</summary>")
    out.append("")
    out += [f"- `{(f + '/') if f else ''}{n}`" for f, n in promoted]
    out += ["", "</details>", ""]
    if skipped:
        out.append(f"<details><summary>{len(skipped)} skipped binaries</summary>")
        out.append("")
        out += [f"- `{(f + '/') if f else ''}{n}`" for f, n in skipped]
        out += ["", "</details>", ""]
    out.append(
        "> From the published test-channel index, which can lag the bucket by up to "
        "an hour. The approved job lists the exact S3 objects before copying."
    )
    return "\n".join(out)


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    package, version = sys.argv[1], sys.argv[2]
    targets = [t for t in (sys.argv[3] if len(sys.argv) > 3 else "").split(",") if t]
    for t in targets:
        if not re.fullmatch(r"[a-z0-9.]+", t):
            sys.exit(f"invalid skip target '{t}' (expected e.g. cu130)")

    url = index_url(package)
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            html = resp.read().decode()
    except urllib.error.URLError as e:
        print(f"### Binaries to promote: `{package}` {version}\n")
        print(f"Could not read `{url}` ({e}); the approved job still lists the binaries before copying.")
        return

    binaries = list_binaries(package, version, html)
    if not binaries:
        print(f"### Binaries to promote: `{package}` {version}\n")
        print(f"**No binaries named `{package}-{version}*` in `{url}`.** Nothing would be promoted.")
        return
    print(render(package, version, targets, binaries))


if __name__ == "__main__":
    main()
