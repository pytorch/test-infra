#!/usr/bin/env python3
"""
Compare the dependency packages of two download.pytorch.org index targets, e.g.
whl/test/cu134 against whl/cu134 before and after syncing prod.

Only the packages update_dependencies.py would create for the target
(get_packages_for_target) are compared, so the test channel's extra projects (vllm
and its dependencies) do not show up as noise. For each of them, the set of files
listed on the two package pages is compared. Exits non-zero if the destination is
missing a package or any file the source has.

Example:

    python3 s3_management/compare_targets.py --source whl/test/cu134 --dest whl/cu134
"""

import argparse
import ast
import concurrent.futures as cf
import re
import sys
import typing
from pathlib import Path
from typing import Dict, List, Optional, Set
from urllib.error import HTTPError
from urllib.request import urlopen


DEFAULT_BASE_URL = "https://download.pytorch.org"
_FUNCTIONS = {"is_nvidia_package", "is_amd_package", "get_packages_for_target"}


def normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def expected_packages(target: str) -> List[str]:
    """
    PACKAGES_PER_PROJECT and get_packages_for_target, taken from
    update_dependencies.py without importing it (it needs boto3 and builds S3
    clients on import).
    """
    source = (Path(__file__).parent / "update_dependencies.py").read_text()
    nodes = []
    for node in ast.parse(source).body:
        if isinstance(node, ast.FunctionDef) and node.name in _FUNCTIONS:
            nodes.append(node)
        elif isinstance(node, ast.AnnAssign) and getattr(node.target, "id", "") == (
            "PACKAGES_PER_PROJECT"
        ):
            nodes.append(node)
    namespace: Dict[str, typing.Any] = {"Dict": typing.Dict, "List": typing.List}
    exec(
        compile(ast.Module(body=nodes, type_ignores=[]), "update_deps", "exec"),
        namespace,
    )
    return sorted({normalize(p) for p in namespace["get_packages_for_target"](target)})


def listed_files(url: str) -> Optional[Set[str]]:
    """File names on a package or target index page, or None if the page is absent."""
    try:
        with urlopen(url, timeout=60) as response:
            html = response.read().decode("utf-8", "replace")
    except HTTPError as e:
        if e.code in (403, 404):
            return None
        raise
    return set(re.findall(r"<a [^>]*>([^<]+)</a>", html))


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--source", required=True, help="e.g. whl/test/cu134")
    parser.add_argument("--dest", required=True, help="e.g. whl/cu134")
    parser.add_argument("--target", help="Target name; default is the last path part")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    source = f"{base}/{args.source.strip('/')}"
    dest = f"{base}/{args.dest.strip('/')}"
    target = args.target or args.source.rstrip("/").rsplit("/", 1)[-1]
    expected = expected_packages(target)
    print(f"{target}: update_dependencies.py creates {len(expected)} packages")

    dest_index = listed_files(f"{dest}/")
    if dest_index is None:
        print(f"MISSING: {args.dest}/ does not exist")
    source_index = listed_files(f"{source}/") or set()
    names_source = {normalize(n) for n in source_index}
    names_dest = {normalize(n) for n in (dest_index or set())}

    problems = 0
    for label, names in ((args.source, names_source), (args.dest, names_dest)):
        missing = [p for p in expected if p not in names]
        if missing:
            print(f"{label}: no index page for {len(missing)}: {missing}")
    problems += len([p for p in expected if p in names_source and p not in names_dest])

    def compare(package: str):
        return (
            package,
            listed_files(f"{source}/{package}/"),
            listed_files(f"{dest}/{package}/"),
        )

    with cf.ThreadPoolExecutor(8) as pool:
        rows = list(pool.map(compare, [p for p in expected if p in names_source]))
    identical = 0
    for package, src, dst in rows:
        if src is None:
            continue
        if dst is None:
            print(f"  {package}: absent in {args.dest} ({len(src)} files in source)")
        elif src == dst:
            identical += 1
        else:
            behind = sorted(src - dst)
            ahead = sorted(dst - src)
            print(
                f"  {package}: source {len(src)} files, dest {len(dst)}; "
                f"missing from dest {len(behind)}"
                + (f" (e.g. {behind[0]})" if behind else "")
                + (f"; only in dest {len(ahead)}" if ahead else "")
            )
            problems += 1 if behind else 0
    print(
        f"\n{identical}/{len(rows)} packages identical; {problems} where dest is behind"
    )
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
