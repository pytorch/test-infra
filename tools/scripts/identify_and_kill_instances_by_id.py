#!/bin/env python3
import argparse
import os

import boto3
from dotenv import load_dotenv
from tqdm import tqdm


"""
This script expects a file named instances.txt with one AWS instance id per line.
It will go through those instances, and kill them if they are running
To be used in case of runner issues or security concerns to quickly kill a subset of runners.
Note this will stop and fail tests that are currently running.
"""

# Load credentials from .env file if available
load_dotenv()


def get_ec2_client(region):
    access_key = os.getenv("AWS_ACCESS_KEY_ID")
    secret_key = os.getenv("AWS_SECRET_ACCESS_KEY")
    if not all([access_key, secret_key]):
        # trying with default .aws/credentials
        return boto3.client("ec2", region_name=region)

    return boto3.client(
        "ec2",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=region,
    )


def main(filename, region="us-east-1", dryrun=False):
    ec2 = get_ec2_client(region=region)

    with open(filename, "r") as f:
        instance_ids = [line.strip() for line in f.readlines()]

    print(
        f"Found {len(instance_ids)} instances in {filename} - region {region} - dryrun {dryrun}"
    )

    non_existent_instances = []
    running_instances = []
    not_running_instances = []

    pbar = tqdm(instance_ids, desc="Listing instances")
    for instance_id in pbar:
        try:
            response = ec2.describe_instances(InstanceIds=[instance_id])
            status = response["Reservations"][0]["Instances"][0]["State"]["Name"]
            if status == "running":
                running_instances.append(instance_id)
                if not dryrun:
                    ec2.terminate_instances(InstanceIds=[instance_id])
            else:
                not_running_instances.append(instance_id)
        except Exception as e:
            non_existent_instances.append(instance_id)
        pbar.set_postfix(
            {
                "Non-existent": len(non_existent_instances),
                "Running": len(running_instances),
                "Not running": len(not_running_instances),
            }
        )
    print("\nTerminated instances:")
    for instance_id in running_instances:
        print(instance_id)
    print("\nExisted but not running:")
    for instance_id in not_running_instances:
        print(instance_id)
    print("\nNon-existent instances:")
    for instance_id in non_existent_instances:
        print(instance_id)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Terminate EC2 instances")
    parser.add_argument(
        "--filename", required=True, help="File containing instance IDs"
    )
    parser.add_argument(
        "--dryrun",
        action="store_true",
        help="Dry run mode (do not actually terminate instances)",
    )
    parser.add_argument(
        "--region", help="region to query ec2 instances from", default="us-east-1"
    )
    args = parser.parse_args()
    main(filename=args.filename, region=args.region, dryrun=args.dryrun)
