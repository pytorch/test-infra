#!/usr/bin/env python3

import gzip
import json
import os
from typing import Any
from urllib.request import urlopen
from warnings import warn

import boto3
from octokit import Octokit


S3 = boto3.resource("s3")
BUCKET_NAME = "ossci-raw-job-status"
BUCKET = S3.Bucket(BUCKET_NAME)

DYNAMO = boto3.resource("dynamodb")


def json_dumps(body: Any) -> str:
    # This logic is copied from github-status-test lambda function
    return json.dumps(body, sort_keys=True, indent=4, separators=(",", ": "))


def upload_log(
    client: Octokit, owner: str, repo: str, job_id: int, conclusion: str
) -> None:
    # This logic is copied from github-status-test lambda function
    log = client.actions.download_job_logs_for_workflow_run(
        owner=owner, repo=repo, job_id=job_id
    ).json

    log_path = f"log/{job_id}"
    if repo != "pytorch":
        log_path = f"log/{owner}/{repo}/{job_id}"

    print(f"..Uploading log to {log_path}")
    try:
        # This needs to be in try catch because GitHub doesn't keep log older than 60 days I think
        S3.Object(BUCKET_NAME, log_path).put(
            Body=gzip.compress(log.encode(encoding="UTF-8")),
            ContentType="text/plain",
            ContentEncoding="gzip",
            Metadata={"conclusion": conclusion},
        )

        # Invoke log classifier
        urlopen(
            f"https://vwg52br27lx5oymv4ouejwf4re0akoeg.lambda-url.us-east-1.on.aws/?job_id={job_id}&repo={owner}/{repo}"
        )
    except Exception as error:
        warn(
            f"Failed to upload {log} for job {job_id} from repo {owner}/{repo}: "
            + f"{error}, skipping..."
        )


def process_event(owner: str, repo: str, event: str, body: Any) -> None:
    # This logic is copied from github-status-test lambda function
    if repo == "pytorch":
        repo_prefix = ""
    else:
        repo_prefix = f"{owner}/{repo}/"

    if "id" not in body:
        warn(f"Missing ID in {body}, skipping...")
        return

    id = body["id"]
    print(f"{event}/{repo_prefix}{id}")
    S3.Object(BUCKET_NAME, f"{event}/{repo_prefix}{id}").put(
        Body=json_dumps(body), ContentType="application/json"
    )

    dynamodb_table = ""
    if event == "workflow_run":
        dynamodb_table = "torchci-workflow-run"
    elif event == "workflow_job":
        dynamodb_table = "torchci-workflow-job"

    if not dynamodb_table:
        return

    body["dynamoKey"] = f"{owner}/{repo}/{id}"
    DYNAMO.Table(dynamodb_table).put_item(Item=body)


def process_workflow_run(
    client: Octokit, owner: str, repo: str, event: str, workflow_run: Any
) -> None:
    process_event(owner, repo, event, workflow_run)

    count = 0
    run_id = workflow_run["id"]
    # Process all the workflow jobs from the run
    params = {
        "owner": owner,
        "repo": repo,
        "run_id": run_id,
        "filter": "all",
        "per_page": 100,
        "page": 1,
    }

    while True:
        response = client.actions.list_jobs_for_workflow_run(**params).json
        if not response:
            warn(
                f"Fetching workflow_job for run {run_id} from repo {owner}/{repo} "
                + f"with {params} returns no response, skipping..."
            )
            return

        if "total_count" not in response:
            warn(
                f"Fetching workflow_job for run {run_id} from repo {owner}/{repo} "
                f"with {params} returns an invalid response {response}, skipping..."
            )
            return

        total_count = response.get("total_count", 0)
        if not total_count:
            # Finish processing all events
            return

        count += len(response["jobs"])
        print(f"..Processing {count} jobs...")
        for workflow_job in response.get("jobs", []):
            job_id = workflow_job["id"]
            conclusion = workflow_job["conclusion"]

            process_event(owner, repo, "workflow_job", workflow_job)
            upload_log(client, owner, repo, job_id, conclusion)

        if not count or count >= total_count:
            # Finish processing all events
            return

        params["page"] += 1


def backfill(
    owner: str, repo: str, event: str, branch: str = "", limit: int = 0
) -> None:
    token = os.environ.get("GITHUB_TOKEN", "")
    client = Octokit(auth="token", token=token)
    count = 0

    if event == "workflow_run":
        params = {"owner": owner, "repo": repo, "per_page": 100, "page": 1}

        if branch:
            params["branch"] = branch

        while True:
            # This returns all events, so there is no need for paging manually
            response = client.actions.list_workflow_runs_for_repo(**params).json
            if not response:
                warn(
                    f"Fetching {event} for repo {owner}/{repo} with {params} "
                    f"returns no response, exiting..."
                )
                return

            if "total_count" not in response:
                warn(
                    f"Fetching {event} for repo {owner}/{repo} with {params} "
                    f"returns an invalid response {response}, exiting..."
                )
                return

            total_count = response.get("total_count", 0)
            if not total_count:
                # Finish processing all events
                return

            count += len(response["workflow_runs"])
            print(f"Processing {count} {event} events...")
            for workflow_run in response.get("workflow_runs", []):
                process_workflow_run(client, owner, repo, event, workflow_run)

            if not count or count >= total_count:
                # Finish processing all events
                return

            if limit and count >= limit:
                # Finish processing all events
                return

            params["page"] += 1  # type: ignore[operator]


def parse_args() -> Any:
    from argparse import ArgumentParser

    parser = ArgumentParser("Backfill all events of a selected type for a GitHub repo")
    parser.add_argument(
        "--owner",
        type=str,
        default="pytorch",
        help="the repo owner",
    )
    parser.add_argument(
        "--repo",
        type=str,
        required=True,
        help="the repo name",
    )
    parser.add_argument(
        "--event",
        type=str,
        required=True,
        choices=["workflow_run"],
        help="the event type",
    )
    parser.add_argument(
        "--branch",
        type=str,
        default="",
        help="limit the event to a certain branch, leave it empty for all branches",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="limit the total number of events, 0 for backfilling all events",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    backfill(args.owner, args.repo, args.event, args.branch)


if __name__ == "__main__":
    main()
