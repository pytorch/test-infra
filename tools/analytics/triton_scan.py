#!/usr/bin/env python3
"""
Check the triton side of the releases in flight, and record it in misc.release_event: for
every release portal step whose check is `triton_release_branch` (the triton release branch
is cut and pytorch's pin is on it) or `pypi_release` (triton is released to PyPI), whether
it holds.

The triton version of a release is `versions.triton` in
release/portal/config/releases/<version>.yml. A release without it leaves both steps to do,
and the scan warns.

Only the standard library and PyYAML (through the portal config) are needed, and no checkout
of pytorch: the releases in flight are the open milestones of pytorch/pytorch whose
v<version> tag does not exist yet.
"""

import argparse
import base64
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote


sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dev_discuss_scan import get, github_get, releases_in_flight  # noqa: E402
from github_analyze import (  # noqa: E402
    insert_clickhouse_rows,
    workflow_run_info,
    write_step_summary,
)


TRITON_REPO = "triton-lang/triton"
PIN_FILE = ".ci/docker/ci_commit_pins/triton.txt"
PYPI = "https://pypi.org/pypi"
CHECK_TYPES = ("triton_release_branch", "pypi_release")
# the rows of the scans of this run, for the job summary
SCANNED_ROWS: List[Dict[str, Any]] = []


def triton_branch(version: str) -> str:
    """The triton release branch of a triton version: 3.9.0 is on release/3.9.x."""
    major, minor = version.split(".")[:2]
    return f"release/{major}.{minor}.x"


def read_pin(release_branch: str) -> Tuple[str, str]:
    """The triton pin of pytorch, and the ref it was read from: the release branch once it
    is cut, main before. A release branch that does not exist yet is a 404."""
    path = f"repos/pytorch/pytorch/contents/{PIN_FILE}"
    for ref in (release_branch, "main"):
        found = github_get(f"{path}?ref={quote(ref, safe='')}", allow_404=True)
        if found is not None:
            return base64.b64decode(found["content"]).decode().strip(), ref
    raise RuntimeError(f"{PIN_FILE} is not in pytorch main")


def pin_on_branch(pin: str, branch: str) -> Optional[bool]:
    """Whether the pinned commit is on the triton branch (its tip or an ancestor of it);
    None when triton does not know the commit."""
    compared = github_get(
        f"repos/{TRITON_REPO}/compare/{quote(branch, safe='')}...{pin}",
        allow_404=True,
    )
    if compared is None:
        return None
    return compared["status"] in ("identical", "behind")


def pypi_upload(package: str, version: str) -> Optional[str]:
    """When the version of the package was uploaded to PyPI, None when it is not there."""
    found = get(f"{PYPI}/{package}/{version}/json", allow_404=True)
    if found is None:
        return None
    uploads = [u["upload_time_iso_8601"] for u in found.get("urls", [])]
    return min(uploads) if uploads else ""


def branch_result(
    release: str,
    triton_version: Optional[str],
    release_branch: str,
    branch_exists: Callable[[str], bool],
    pin_for: Callable[[str], Tuple[str, str]],
    on_branch: Callable[[str, str], Optional[bool]],
) -> Tuple[str, str, str, Dict[str, Any]]:
    """The status, evidence text, evidence URL and details of the triton release branch step."""
    file_name = f"release/portal/config/releases/{release}.yml"
    if triton_version is None:
        return (
            "todo",
            f"versions.triton is not set in {file_name}",
            f"https://github.com/{TRITON_REPO}/branches",
            {},
        )
    branch = triton_branch(triton_version)
    url = f"https://github.com/{TRITON_REPO}/tree/{branch}"
    details: Dict[str, Any] = {"triton_version": triton_version, "branch": branch}
    if not branch_exists(branch):
        return "todo", f"{TRITON_REPO} has no branch {branch}", url, details
    pin, ref = pin_for(release_branch)
    details.update(pin=pin, pin_read_from=ref)
    landed = on_branch(pin, branch)
    short = pin[:10]
    if landed:
        text = f"{branch} exists and the pin {short} ({ref}) is on it"
        return "done", text, url, details
    why = "is not on it" if landed is False else "is not a triton commit"
    text = f"{branch} exists, but the pin {short} in pytorch {ref} {why}"
    return "in_progress", text, url, details


def pypi_result(
    package: str, version: Optional[str], release: str, uploaded: Callable[[str], Any]
) -> Tuple[str, str, str, Dict[str, Any]]:
    """The status, evidence text, evidence URL and details of a pypi_release step."""
    if version is None:
        file_name = f"release/portal/config/releases/{release}.yml"
        return (
            "todo",
            f"versions.triton is not set in {file_name}",
            f"https://pypi.org/project/{package}/",
            {},
        )
    url = f"https://pypi.org/project/{package}/{version}/"
    details: Dict[str, Any] = {"package": package, "version": version}
    when = uploaded(version)
    if when is None:
        return "todo", f"{package} {version} is not on PyPI", url, details
    details["uploaded_at"] = when
    text = f"{package} {version} is on PyPI (uploaded {when[:10]})"
    return "done", text, url, details


def triton_step_rows(
    release: str,
    config: Dict[str, Any],
    branch_exists: Callable[[str], bool],
    pin_for: Callable[[str], Tuple[str, str]],
    on_branch: Callable[[str, str], Optional[bool]],
    uploaded: Callable[[str, str], Any],
    config_sha: str,
    run_id: str,
    run_url: str,
    observed_at: datetime,
) -> List[Dict[str, Any]]:
    """
    The misc.release_event rows of one scan of a release's triton steps: one per
    triton_release_branch or pypi_release step, todo until its check holds and done once it
    does (the branch step is in_progress while the branch exists without the pin on it).
    """
    triton_version = (config.get("versions") or {}).get("triton")
    rows = []
    for step in config["steps"]:
        check = step["check"]
        if check["type"] not in CHECK_TYPES:
            continue
        if check["type"] == "triton_release_branch":
            status, evidence, url, details = branch_result(
                release,
                triton_version,
                config["branch"],
                branch_exists,
                pin_for,
                on_branch,
            )
        else:
            version: Optional[str] = check["version"]
            if "{triton_version}" in check["version"]:
                version = (
                    check["version"].replace("{triton_version}", triton_version)
                    if triton_version
                    else None
                )
            package: str = check["package"]
            status, evidence, url, details = pypi_result(
                package,
                version,
                release,
                lambda v: uploaded(package, v),
            )
        rows.append(
            {
                "release": release,
                "step_id": step["id"],
                "rc": "",
                "status": status,
                "blocking": 0,
                "evidence_text": evidence,
                "evidence_url": url,
                "check_type": check["type"],
                "source": "collector",
                "run_id": run_id,
                "run_url": run_url,
                "config_sha": config_sha,
                "details": json.dumps(details),
                "observed_at": observed_at.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
            }
        )
    return rows


def branch_exists(branch: str) -> bool:
    return (
        github_get(
            f"repos/{TRITON_REPO}/git/ref/heads/{quote(branch, safe='/')}",
            allow_404=True,
        )
        is not None
    )


def scan_release(release: str, write: bool, summary: List[str]) -> bool:
    """Scan and print one release; returns False when it has no release file."""
    from torchci.release_portal_config import load_resolved, RELEASES_DIR

    if not (RELEASES_DIR / f"{release}.yml").exists():
        print(
            f"::error::{release} is in flight but has no "
            f"release/portal/config/releases/{release}.yml"
        )
        summary.append(f"- {release}: no release file")
        return False
    config = load_resolved(release)
    run_id, run_url = workflow_run_info()
    rows = triton_step_rows(
        release,
        config,
        branch_exists,
        read_pin,
        pin_on_branch,
        pypi_upload,
        os.environ.get("GITHUB_SHA", "0" * 40),
        run_id,
        run_url,
        datetime.now(timezone.utc),
    )
    SCANNED_ROWS.extend(rows)
    for row in rows:
        print(f"step {row['step_id']}: {row['status']}: {row['evidence_text']}")
    if write and rows:
        insert_clickhouse_rows("misc.release_event", rows)
        print(f"Inserted {len(rows)} rows into misc.release_event")
    if (config.get("versions") or {}).get("triton") is None:
        print(f"::warning::{release}: versions.triton is not set in its release file")
        summary.append(f"- {release}: set `versions.triton` in its release file")
    return True


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--release",
        action="append",
        help="a release to scan (X.Y.Z); repeatable. Default: the releases in flight",
    )
    parser.add_argument(
        "--write-to-clickhouse",
        action="store_true",
        help="record the steps in misc.release_event (CLICKHOUSE_ENDPOINT, "
        "CLICKHOUSE_USERNAME and CLICKHOUSE_PASSWORD)",
    )
    args = parser.parse_args(argv)

    releases = args.release or releases_in_flight()
    print(f"Releases in flight: {', '.join(releases) if releases else 'none'}")
    SCANNED_ROWS.clear()
    ok = True
    summary: List[str] = []
    for release in releases:
        print(f"::group::{release}")
        try:
            ok = scan_release(release, args.write_to_clickhouse, summary) and ok
        except Exception as err:
            print(f"::error::{release}: {err}")
            ok = False
        finally:
            print("::endgroup::")
    write_step_summary("Triton steps", SCANNED_ROWS, args.write_to_clickhouse)
    if summary and os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write("## Triton versions to set\n\n" + "\n".join(summary) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
