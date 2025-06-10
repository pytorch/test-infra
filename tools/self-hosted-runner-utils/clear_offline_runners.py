import argparse
import os
import random
import time
from typing import List, Set

import boto3  # type: ignore[import-untyped]
from botocore.exceptions import ClientError  # type: ignore[import-untyped]
from github import (  # type: ignore[import-not-found]
    Github,
    PaginatedList,
    SelfHostedActionsRunner,
)
from tqdm import tqdm  # type: ignore[import-untyped]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Clear offline self hosted runners for Github repositories"
    )
    parser.add_argument(
        "entity",
        help="Repository to remove offline self hosted runners for, (ex. pytorch/pytorch)",
        type=str,
    )
    parser.add_argument(
        "--dry-run",
        help="Don't actually remove the runners, just output which runners would be removed",
        action="store_true",
        default=False,
    )
    parser.add_argument(
        "--runner-name",
        help="AWS Runner Name to filter for EC2 instances.",
        type=str,
        default="gh-ci-action-runner",
    )
    parser.add_argument(
        "--token",
        help="Github token to pull from (Can also pass GITHUB_TOKEN as an env variable)",
        type=str,
        default=os.getenv("GITHUB_TOKEN", ""),
    )
    options = parser.parse_args()
    return options


def get_self_hosted_runners_org(org):  # type: ignore[no-untyped-def]
    return PaginatedList.PaginatedList(
        SelfHostedActionsRunner.SelfHostedActionsRunner,
        org._requester,
        f"https://api.github.com/orgs/{org.login}/actions/runners",
        None,
        list_item="runners",
    )


def get_aws_instances_by_name(ec2, name_pattern: str) -> List[dict]:
    response = ec2.describe_instances(
        Filters=[
            {"Name": "tag:Name", "Values": [name_pattern]},
            {
                "Name": "instance-state-name",
                "Values": ["running", "pending", "stopping", "stopped"],
            },
        ]
    )

    instances = []
    for reservation in response["Reservations"]:
        for instance in reservation["Instances"]:
            name = ""
            for tag in instance.get("Tags", []):
                if tag["Key"] == "Name":
                    name = tag["Value"]
                    break
            instances.append(
                {
                    "id": instance["InstanceId"],
                    "name": name,
                    "state": instance["State"]["Name"],
                }
            )

    return instances


def get_runner_instance_intersection(
    runners: List, aws_instances: List[dict]
) -> tuple[Set[str], List[dict]]:
    runner_names = {runner.name for runner in runners}
    aws_instance_names = {instance["id"] for instance in aws_instances}

    intersection = runner_names.intersection(aws_instance_names)

    non_intersecting_instances = [
        instance for instance in aws_instances if instance["id"] not in intersection
    ]

    return intersection, non_intersecting_instances


def terminate_instances_safe(instance_ids, batch_size=100, dry_run=True):
    """
    Terminate instances with exponential backoff for rate limiting
    """
    ec2 = boto3.client("ec2")

    batches = [
        instance_ids[i : i + batch_size]
        for i in range(0, len(instance_ids), batch_size)
    ]
    results = []

    for i, batch in tqdm(enumerate(batches, 1)):
        max_retries = 3

        for retry in range(max_retries):
            try:
                response = ec2.terminate_instances(InstanceIds=batch, DryRun=dry_run)
                results.append(response)
                print(f"Batch {i}/{len(batches)} successful")
                break

            except ClientError as e:
                if e.response["Error"]["Code"] == "RequestLimitExceeded":
                    if retry < max_retries - 1:
                        # Exponential backoff with jitter
                        delay = (2**retry) + random.uniform(0, 1)
                        print(f"Rate limited, retrying in {delay:.1f}s...")
                        time.sleep(delay)
                    else:
                        print(f"Batch {i} failed after {max_retries} retries")
                        results.append(None)
                else:
                    print(f"Batch {i} failed: {e}")
                    results.append(None)
                    break

        # Small delay between successful batches
        if i < len(batches):
            time.sleep(0.5)

    return results


def main() -> None:
    ec2 = boto3.client("ec2")
    options = parse_args()
    if options.token == "":
        raise Exception("GITHUB_TOKEN or --token must be set")

    # Get AWS instances with name {options.runner_name}
    aws_instances = get_aws_instances_by_name(ec2, f"{options.runner_name}")
    print(f"Found {len(aws_instances)} AWS instances with name '{options.runner_name}'")

    gh = Github(options.token)
    if "/" in options.entity:
        entity_get = gh.get_repo
        entity = entity_get(options.entity)
        runners = entity.get_self_hosted_runners()
    else:
        runners = get_self_hosted_runners_org(gh.get_organization(options.entity))

    # Convert runners to list for intersection calculation
    runners_list = list(runners)
    print(f"Found {len(runners_list)} GitHub runners")

    # Get intersection and non-intersecting instances
    intersection, non_intersecting_instances = get_runner_instance_intersection(
        runners_list, aws_instances
    )
    instance_ids = list()
    print(
        f"\nAWS instances NOT part of intersection: {len(non_intersecting_instances)}"
    )
    for instance in non_intersecting_instances:
        instance_ids.append(instance["id"])

    terminate_instances_safe(instance_ids, dry_run=options.dry_run)


if __name__ == "__main__":
    main()
