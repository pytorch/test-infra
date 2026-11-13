#!/usr/bin/env python3
"""
Scan the Release Announcements category of dev-discuss.pytorch.org for the posts of the
releases in flight, and record them in misc.release_event: for every release portal step
whose check is `dev_discuss_post` (key dates, branch cut, RC1, final RC, GA), whether the
release's post exists.

The key dates post also carries the release's planned dates. They are compared with
`dates` in release/portal/config/releases/<version>.yml, which the portal's due dates are
computed from; the scan fails when the file is missing, has no dates or differs from the
post, and prints the `dates` block to put in it.

Only the standard library and PyYAML (through the portal config) are needed, and no
checkout of pytorch: the releases in flight are the open milestones of pytorch/pytorch
whose v<version> tag does not exist yet.
"""

import argparse
import html
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from github_analyze import insert_clickhouse_rows, workflow_run_info  # noqa: E402


DEV_DISCUSS = "https://dev-discuss.pytorch.org"
CATEGORY = "release-announcements/27"
CATEGORY_URL = f"{DEV_DISCUSS}/c/{CATEGORY}"
CATEGORY_PAGES = 4  # 30 topics a page, newest first: a release cycle is ~7 posts
GITHUB_API = "https://api.github.com"
VERSION_TITLE = re.compile(r"^\d+\.\d+\.\d+$")

# The milestone rows of the key dates table by release type, to the portal's date anchors
# (the config's `dates`). A minor release's M3 is the branch cut and RC1 (the week of),
# M4 the final RC (the week of) and M6 the release day. A patch release has no branch
# cut: its M3 is when the RC binaries are ready and M4 is the release.
DATE_ROWS = {
    "minor": {"M3": "branch_cut", "M4": "final_rc", "M6": "ga"},
    "patch": {"M3": "final_rc", "M4": "ga"},
}
ANCHORS = ("branch_cut", "final_rc", "ga")


def get(
    url: str, headers: Optional[Dict[str, str]] = None, allow_404: bool = False
) -> Any:
    """The JSON at the URL; None for a 404 when allowed. A 5xx or a network error is
    retried, since one failed request must not fail the scan of a release."""
    request_headers = {"User-Agent": "pytorch-test-infra-release-portal"}
    request_headers.update(headers or {})
    for attempt in range(4):
        try:
            with urlopen(Request(url, headers=request_headers), timeout=30) as data:
                return json.load(data)
        except HTTPError as err:
            if err.code == 404 and allow_404:
                return None
            if err.code < 500 or attempt == 3:
                raise
        except URLError:
            if attempt == 3:
                raise
        time.sleep(2**attempt)


def github_get(path: str, allow_404: bool = False) -> Any:
    headers = {"Accept": "application/vnd.github+json"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    return get(f"{GITHUB_API}/{path}", headers, allow_404)


def releases_in_flight(release_lines: int = 3) -> List[str]:
    """
    The releases in flight, newest first: the open milestones of pytorch/pytorch titled
    with a version (X.Y.Z) of the latest release lines, whose tag v<version> does not
    exist. The latest lines are those of main's version.txt (2.16.0a0) and the two before
    it, like the releases github_analyze.py --in-flight scans. The milestone of a release
    that has shipped is often left open, which is why the tag decides, and an old
    milestone of a release that never shipped (2.8.1) is not a release in flight.
    """
    request = Request(
        "https://raw.githubusercontent.com/pytorch/pytorch/main/version.txt",
        headers={"User-Agent": "pytorch-test-infra-release-portal"},
    )
    with urlopen(request, timeout=30) as data:
        match = re.match(r"(\d+)\.(\d+)\.", data.read().decode())
    if not match:
        return []
    major, minor = int(match.group(1)), int(match.group(2))
    lines = {f"{major}.{minor - back}." for back in range(release_lines)}
    versions = sorted(
        {
            m["title"]
            for m in github_get(
                "repos/pytorch/pytorch/milestones?state=open&per_page=100"
            )
            if VERSION_TITLE.match(m.get("title", ""))
            and m["title"].rsplit(".", 1)[0] + "." in lines
        },
        key=lambda v: tuple(int(p) for p in v.split(".")),
        reverse=True,
    )
    return [
        version
        for version in versions
        if github_get(f"repos/pytorch/pytorch/git/ref/tags/v{version}", allow_404=True)
        is None
    ]


def list_topics(pages: int = CATEGORY_PAGES) -> List[Dict[str, Any]]:
    """The newest topics of the Release Announcements category."""
    topics: List[Dict[str, Any]] = []
    for page in range(pages):
        found = get(f"{CATEGORY_URL}.json?page={page}")["topic_list"]["topics"]
        topics.extend(found)
        if len(found) < 30:
            break
    return topics


def topic_url(topic: Dict[str, Any]) -> str:
    return f"{DEV_DISCUSS}/t/{topic['slug']}/{topic['id']}"


def fetch_first_post(topic_id: int) -> Tuple[str, str]:
    """The current HTML of the first post of a topic, and when the topic was created."""
    topic = get(f"{DEV_DISCUSS}/t/{topic_id}.json")
    return topic["post_stream"]["posts"][0]["cooked"], topic["created_at"]


# ---------------------------------------------------------------- the key dates table


class _Rows(HTMLParser):
    """The cells of every table row, as text."""

    def __init__(self) -> None:
        super().__init__()
        self.rows: List[List[str]] = []
        self._row: Optional[List[str]] = None
        self._cell: Optional[List[str]] = None

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append(html.unescape("".join(self._cell)).strip())
            self._cell = None
        elif tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)


MONTHS = {
    name: number
    for number, name in enumerate(
        [
            "january",
            "february",
            "march",
            "april",
            "may",
            "june",
            "july",
            "august",
            "september",
            "october",
            "november",
            "december",
        ],
        start=1,
    )
}


def parse_date(text: str, posted: date) -> Optional[date]:
    """
    A date of the table: `27/11/26` or `week of 30/11/26` (day/month/year; a week is
    dated by its first day) or `September 28` (no year: the next one that is not before
    the post, with a month of slack for a date just before it).
    """
    match = re.search(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", text)
    if match:
        day, month, year = (int(g) for g in match.groups())
        try:
            return date(year + 2000 if year < 100 else year, month, day)
        except ValueError:
            return None
    match = re.search(r"([A-Za-z]+)\.? (\d{1,2})(?:, (\d{4}))?", text)
    if match and match.group(1).lower() in MONTHS:
        month, day = MONTHS[match.group(1).lower()], int(match.group(2))
        year = int(match.group(3)) if match.group(3) else posted.year
        try:
            found = date(year, month, day)
        except ValueError:
            return None
        if not match.group(3) and found < posted - timedelta(days=30):
            found = date(year + 1, month, day)
        return found
    return None


def parse_key_dates(
    cooked: str, release_type: str, posted: date
) -> Dict[str, Optional[str]]:
    """
    The planned dates of a key dates post, by the portal's anchors (YYYY-MM-DD): from the
    milestone table, M3, M4 and M6 of a minor release and M3 and M4 of a patch release.
    An anchor the table does not give, or a date that cannot be read, is None.
    """
    parser = _Rows()
    parser.feed(cooked)
    by_milestone = {row[0]: row[-1] for row in parser.rows if len(row) >= 2}
    dates: Dict[str, Optional[str]] = dict.fromkeys(ANCHORS)
    for milestone, anchor in DATE_ROWS[release_type].items():
        parsed = parse_date(by_milestone.get(milestone, ""), posted)
        dates[anchor] = parsed.isoformat() if parsed else None
    return dates


def date_drift(
    config: Dict[str, Optional[str]], post: Dict[str, Optional[str]]
) -> Dict[str, Dict[str, Optional[str]]]:
    """The anchors whose date in the release file is not the post's: {anchor: {file, post}}."""
    return {
        anchor: {"file": config.get(anchor), "post": post.get(anchor)}
        for anchor in ANCHORS
        if config.get(anchor) != post.get(anchor)
    }


def dates_block(dates: Dict[str, Optional[str]]) -> str:
    """The `dates:` block of a release file for the post's dates."""
    lines = ["dates:"]
    lines += [f"  {anchor}: {dates.get(anchor) or 'null'}" for anchor in ANCHORS]
    return "\n".join(lines)


# ---------------------------------------------------------------- the steps


def title_pattern(
    check: Dict[str, Any], version: str, release_type: str
) -> "re.Pattern[str]":
    """The step's title regex for the release, with {version} and {minor} escaped."""
    pattern = check["title_regex"]
    if isinstance(pattern, dict):
        pattern = pattern[release_type]
    minor = ".".join(version.split(".")[:2])
    values = {"version": re.escape(version), "minor": re.escape(minor)}
    return re.compile(re.sub(r"\{(\w+)\}", lambda m: values[m.group(1)], pattern))


def find_topic(
    topics: Iterable[Dict[str, Any]], pattern: "re.Pattern[str]"
) -> Optional[Dict[str, Any]]:
    """The newest topic whose title matches, or None."""
    found = [t for t in topics if pattern.search(t.get("title", ""))]
    return max(found, key=lambda t: t["id"]) if found else None


def post_step_rows(
    release: str,
    config: Dict[str, Any],
    topics: List[Dict[str, Any]],
    fetch_post: Callable[[int], Tuple[str, str]],
    config_sha: str,
    run_id: str,
    run_url: str,
    observed_at: datetime,
) -> Tuple[List[Dict[str, Any]], List[str], Optional[str]]:
    """
    The misc.release_event rows of one scan of a release's dev-discuss posts: one per
    dev_discuss_post step, todo while its post does not exist and done once it does. The
    key dates post is done only when the dates in the release file are the post's;
    otherwise it is in_progress, with the difference in `details`.

    Also returns what is wrong with the release's dates, as messages (none when the post
    does not exist yet), and the post's `dates` block when there is one.
    """
    release_type = config["type"]
    file_name = f"release/portal/config/releases/{release}.yml"
    steps = [s for s in config["steps"] if s["check"]["type"] == "dev_discuss_post"]
    problems: List[str] = []
    proposed: Optional[str] = None
    rows = []
    for step in steps:
        check = step["check"]
        pattern = title_pattern(check, release, release_type)
        topic = find_topic(topics, pattern)
        details: Dict[str, Any] = {"title_regex": pattern.pattern}
        if topic is None:
            status = "todo"
            evidence = f"No post in Release Announcements matches {pattern.pattern}"
            url = CATEGORY_URL
        else:
            status = "done"
            evidence = f"{topic['title']}"
            url = topic_url(topic)
            details.update(
                topic_id=topic["id"],
                title=topic["title"],
                posted_at=topic.get("created_at"),
            )
            if check.get("carries_dates"):
                cooked, created_at = fetch_post(topic["id"])
                posted = datetime.fromisoformat(
                    created_at.replace("Z", "+00:00")
                ).date()
                post_dates = parse_key_dates(cooked, release_type, posted)
                differs = date_drift(config["dates"], post_dates)
                details.update(post_dates=post_dates, file_dates=config["dates"])
                proposed = dates_block(post_dates)
                if not any(post_dates.get(a) for a in DATE_ROWS[release_type].values()):
                    status = "in_progress"
                    evidence = (
                        f"{topic['title']}: the milestone table could not be read"
                    )
                    problems.append(
                        f"the dates in {topic_url(topic)} could not be read"
                    )
                elif differs:
                    status = "in_progress"
                    details["differences"] = differs
                    evidence = (
                        f"{topic['title']}: the dates in {file_name} differ from the post: "
                        + ", ".join(
                            f"{a} {d['file'] or 'not set'} (post: {d['post'] or 'none'})"
                            for a, d in differs.items()
                        )
                    )
                    problems.append(evidence)
                else:
                    evidence = (
                        f"{topic['title']}: the dates in {file_name} are the post's: "
                        + ", ".join(
                            f"{a} {post_dates[a]}" for a in ANCHORS if post_dates.get(a)
                        )
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
                "check_type": "dev_discuss_post",
                "source": "collector",
                "run_id": run_id,
                "run_url": run_url,
                "config_sha": config_sha,
                "details": json.dumps(details),
                "observed_at": observed_at.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
            }
        )
    return rows, problems, proposed


def scan_release(
    release: str, topics: List[Dict[str, Any]], write: bool, summary: List[str]
) -> bool:
    """Scan and print one release; returns whether its dates are in its release file."""
    from torchci.release_portal_config import load_resolved, RELEASES_DIR

    if not (RELEASES_DIR / f"{release}.yml").exists():
        print(
            f"::error::{release} is in flight but has no "
            f"release/portal/config/releases/{release}.yml, so it has no dates"
        )
        summary.append(f"- {release}: no release file")
        return False
    config = load_resolved(release)
    run_id, run_url = workflow_run_info()
    rows, problems, proposed = post_step_rows(
        release,
        config,
        topics,
        fetch_post_cached,
        os.environ.get("GITHUB_SHA", "0" * 40),
        run_id,
        run_url,
        datetime.now(timezone.utc),
    )
    for row in rows:
        print(f"step {row['step_id']}: {row['status']}: {row['evidence_text']}")
    if write:
        insert_clickhouse_rows("misc.release_event", rows)
        print(f"Inserted {len(rows)} rows into misc.release_event")
    dates_step = next(
        (s["id"] for s in config["steps"] if s["check"].get("carries_dates")), None
    )
    if any(row["step_id"] == dates_step and row["status"] == "todo" for row in rows):
        print(f"::warning::{release}: the key dates post is not there yet, so no dates")
        summary.append(f"- {release}: no key dates post yet")
    if problems:
        print(
            f"::error::{release}: {'; '.join(problems)}. The dates of the post are:\n{proposed}"
        )
        summary.append(
            f"- {release}: update `release/portal/config/releases/{release}.yml`\n\n"
            f"```yaml\n{proposed}\n```"
        )
    return not problems


_posts: Dict[int, Tuple[str, str]] = {}


def fetch_post_cached(topic_id: int) -> Tuple[str, str]:
    if topic_id not in _posts:
        _posts[topic_id] = fetch_first_post(topic_id)
    return _posts[topic_id]


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
    topics = list_topics()
    print(f"{len(topics)} topics in Release Announcements")
    ok = True
    summary: List[str] = []
    for release in releases:
        print(f"::group::{release}")
        try:
            ok = scan_release(release, topics, args.write_to_clickhouse, summary) and ok
        except Exception as err:
            print(f"::error::{release}: {err}")
            ok = False
        finally:
            print("::endgroup::")
    if summary and os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write("## Release dates to update\n\n" + "\n".join(summary) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
