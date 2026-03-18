#!/usr/bin/env python3

"""
This script retrieves the storage size of all S3 buckets in your AWS account
using CloudWatch metrics. It lists the buckets and their respective sizes
in gigabytes (GB).

Requirements:
  Before running this script, ensure you have the boto3 library installed
  and your AWS credentials are configured.

Installation:
  pip install boto3
"""

import os
import sys
from datetime import datetime, timedelta, timezone

import boto3


def main():
    print("🔍 Fetching S3 bucket list...")

    # Create S3 and CloudWatch clients
    s3 = boto3.client("s3")

    try:
        # Get buckets
        response = s3.list_buckets()
        buckets = [bucket["Name"] for bucket in response["Buckets"]]
    except Exception as e:
        print(f"❌ Error accessing AWS: {str(e)}")
        sys.exit(1)

    if not buckets:
        print("🚫 No S3 buckets found.")
        sys.exit(0)

    bucket_count = len(buckets)
    print(f"✅ Found {bucket_count} buckets. Fetching storage metrics...")

    # Store results
    results = []

    # Process each bucket
    for i, bucket in enumerate(buckets, 1):
        print(f"({i}/{bucket_count}): Bucket {bucket}")

        # Get bucket region
        try:
            location = s3.get_bucket_location(Bucket=bucket)
            region = location.get("LocationConstraint")
        except Exception as e:
            print(f"   ⚠️ Error getting region for {bucket}: {str(e)}")
            # Assume it's in us-east-1
            region = "us-east-1"

        # Create CloudWatch client for the bucket's region
        cloudwatch = boto3.client("cloudwatch", region_name=region)

        # Get metrics
        try:
            response = cloudwatch.get_metric_statistics(
                Namespace="AWS/S3",
                MetricName="BucketSizeBytes",
                Dimensions=[
                    {"Name": "BucketName", "Value": bucket},
                    {"Name": "StorageType", "Value": "StandardStorage"},
                ],
                StartTime=datetime.now(timezone.utc) - timedelta(days=1),
                EndTime=datetime.now(timezone.utc),
                Period=86400,
                Statistics=["Average"],
            )

            if response["Datapoints"]:
                size = response["Datapoints"][0]["Average"]
            else:
                size = 0
        except Exception as e:
            print(f"   ⚠️ Error getting metrics for {bucket}: {str(e)}")
            size = 0

        if size <= 0:
            print(f"   🫥 No metrics found for bucket: {bucket}. Is it unused?")
        else:
            size_gb = size / 1073741824  # Convert bytes to GB
            formatted_size = f"{size_gb:.1f}"
            print(f"   💿 Storage used: {formatted_size} GB")

        size_gb = size / 1073741824  # Convert bytes to GB
        results.append((size_gb, bucket))

    # Sort by size in descending order
    results.sort(reverse=True)

    # Display results
    print("\n\n📌 Storage Usage Summary:")
    print("Size (GB)\tBucket Name")
    print("----------------------------")
    for size_gb, bucket in results:
        print(f"{size_gb:9.2f}\t{bucket}")

    print("\n✅ Done!")


if __name__ == "__main__":
    main()
