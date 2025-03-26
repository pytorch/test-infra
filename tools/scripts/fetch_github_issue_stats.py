#!/usr/bin/env python3

import json
import os
import time
import warnings
from datetime import date, datetime
from typing import Any, Dict, List, Optional
from urllib.request import Request, urlopen

import pandas as pd

import rockset  # type: ignore[import]

# Aggregate bi-weekly, we could also use w for weekly or m here for monthly
AGGREGATED_WINDOW = "2w"
TRIAGED = "triaged"
HIGH_PRIORITY = "high priority"


def fetch_github_timeline(timeline_url: str) -> List[Dict[str, Any]]:
    """
    We don't keep the timeline of an issue anywhere on Rockset atm, so need to reach
    out to GitHub here to fetch it
    """
    github_token = os.environ.get("GITHUB_TOKEN")
    if not github_token:
        warnings.warn("GITHUB_TOKEN env variable is needed to fetch the issue timeline")
        return

    headers = {
        "Accept": "application/vnd.github.v3+json",
        "Authorization": f"token {github_token}",
    }
    with urlopen(Request(timeline_url, headers=headers)) as conn:
        return json.load(conn)


def calculate_triaged_time(record: Dict[str, Any]) -> Optional[int]:
    """
    Look at the record timeline and calculate the triaged time in second
    """
    labels = record["labels"]
    if TRIAGED not in labels:
        return

    timeline = record.get("timeline", [])
    for e in timeline:
        if e["event"] == "labeled" and e["label"]["name"] == TRIAGED:
            triaged_timestamp = datetime.fromisoformat(e["created_at"])
            diff = triaged_timestamp - datetime.fromisoformat(record["created_at"])
            return int(diff.total_seconds())

    return


def query_issues(
    repo: str,
    states: List[str],
    start_date: date,
    stop_date: date,
    labels: List[str],
    title: str,
) -> List[Dict[str, Any]]:
    rs = rockset.RocksetClient(
        host="api.usw2a1.rockset.com", api_key=os.environ["ROCKSET_API_KEY"]
    )
    params = [
        {"name": "repo", "type": "string", "value": repo},
        {"name": "state", "type": "string", "value": ",".join(states)},
        {"name": "startTime", "type": "string", "value": start_date.isoformat()},
        {"name": "stopTime", "type": "string", "value": stop_date.isoformat()},
        {
            "name": "selectedLabels",
            "type": "string",
            "value": ",".join(labels) if labels else "_",
        },
        {"name": "titleMatchingRegex", "type": "string", "value": title},
    ]
    res = rs.QueryLambdas.execute_query_lambda(
        query_lambda="query_github_issues",
        version="e4413a7f1bcfb0fd",
        workspace="commons",
        parameters=params,
    )

    filtered_results: List[Dict[str, Any]] = []
    for r in res.results:
        if not labels or all(l in r["labels"] for l in labels):
            timeline_url = r.get("timeline_url", "")
            if timeline_url and os.environ.get("GITHUB_TOKEN"):
                print(f"... Fetching {timeline_url}")
                # Fetch the timeline from GitHub
                r["timeline"] = fetch_github_timeline(timeline_url)
            filtered_results.append(r)

    return filtered_results


def analyze(
    data: List[Dict[str, Any]], labels: List[str], start_date: date, stop_date: date
) -> None:
    label_str = f" with labels {json.dumps(labels)}" if labels else ""
    total = len(data)
    print(
        f"Found {total} issues{label_str} in the period from {start_date} to {stop_date}"
    )

    triaged_count = 0
    high_priority_count = 0

    for r in data:
        labels = r["labels"]

        if labels and HIGH_PRIORITY in labels:
            high_priority_count += 1

        if labels and TRIAGED in labels:
            triaged_count += 1

        triaged_time_in_second = calculate_triaged_time(r)
        if triaged_time_in_second:
            # Keep the triage time in hours as this makes most sense?
            r["triaged_time"] = triaged_time_in_second // 3600 + 1
        else:
            r["triaged_time"] = None
        r["not_yet_triaged"] = 1 if r["triaged_time"] is None else 0

    print(
        f"  {high_priority_count} high priority ({int(high_priority_count * 100 / total)}%)"
    )
    print(f"  {triaged_count} has been triaged ({int(triaged_count * 100 / total)}%)")

    df = pd.DataFrame(data=data)
    # Some columns are timestamp
    df.created_at = pd.to_datetime(df.created_at)
    df.updated_at = pd.to_datetime(df.updated_at)
    df.closed_at = pd.to_datetime(df.closed_at)

    monthly_count = (
        df[["title", "created_at"]]
        .resample("2w", on="created_at")
        .count()
        .rename(columns={"title": "total"})
    )
    monthly_hipri = (
        df[df.labels.apply(lambda x: HIGH_PRIORITY in x)][["title", "created_at"]]
        .resample("2w", on="created_at")
        .count()
        .rename(columns={"title": "hi-pri"})
    )
    not_yet_triaged = (
        df[["not_yet_triaged", "created_at"]].resample("2w", on="created_at").sum()
    )

    p50_triaged_time = (
        df[["triaged_time", "created_at"]]
        .resample("2w", on="created_at")
        .quantile(q=0.5)
        .rename(columns={"triaged_time": "triaged_time_hour_p50"})
    )
    p90_triaged_time = (
        df[["triaged_time", "created_at"]]
        .resample("2w", on="created_at")
        .quantile(q=0.9)
        .rename(columns={"triaged_time": "triaged_time_hour_p90"})
    )
    p100_triaged_time = (
        df[["triaged_time", "created_at"]]
        .resample("2w", on="created_at")
        .quantile(q=1.0)
        .rename(columns={"triaged_time": "triaged_time_hour_p100"})
    )

    return (
        monthly_count.join(monthly_hipri, on="created_at", how="left")
        .join(p50_triaged_time)
        .join(p90_triaged_time)
        .join(p100_triaged_time)
        .join(not_yet_triaged)
        .fillna(0)
        .astype(int)
        .rename(columns={"created_at": "bucket"})
    )


def parse_args() -> Any:
    from argparse import ArgumentParser, FileType

    parser = ArgumentParser("Gather issue stats from PyTorch repos")
    parser.add_argument(
        "--owner",
        type=str,
        default="pytorch",
        help="the repo owner",
    )
    parser.add_argument(
        "--repo",
        type=str,
        default="pytorch",
        help="the repo name",
    )
    parser.add_argument(
        "--state",
        type=str,
        choices=["open", "closed", "all"],
        default="all",
        help="the state of the issue",
    )
    parser.add_argument(
        "--start-date",
        type=date.fromisoformat,
        default=date.fromisoformat("1970-01-01"),
        help="the start date",
    )
    parser.add_argument(
        "--stop-date",
        type=date.fromisoformat,
        default=date.today(),
        help="the stop date",
    )
    parser.add_argument(
        "--label",
        type=str,
        default=[],
        nargs="*",
        help="filter issues by labels",
    )
    parser.add_argument(
        "--title",
        type=str,
        default="_",
        help="filter issues by title with regex support",
    )
    parser.add_argument(
        "--input",
        type=FileType(),
        help="use the local JSON file as input instead of getting it from Rockset",
    )
    parser.add_argument(
        "--output",
        type=str,
        required=True,
        help="write the stats to a local CSV file",
    )

    return parser.parse_args()


def main() -> None:
    args = parse_args()

    # Massage the input a bit
    owner = args.owner
    repo = args.repo

    if args.state == "all":
        states = ["open", "closed", "all"]
    else:
        states = [args.state]

    start_date = args.start_date
    stop_date = args.stop_date

    labels = args.label
    title = args.title

    if args.input:
        data = json.loads(args.input.read())
    else:
        # Get the data from Rockset
        data = query_issues(
            f"{owner}/{repo}", states, start_date, stop_date, labels, title
        )
        with open(f"data-{int(time.time())}.json", "w") as f:
            f.write(json.dumps(data, indent=2))

    # Analyze the data and generate the stats
    stats = analyze(data, labels, start_date, stop_date)

    # Dump the stats to a CSV file
    stats.to_csv(args.output)


if __name__ == "__main__":
    main()
