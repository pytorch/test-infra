#!/usr/bin/env python3
"""
EC2 Pricing Map Generator

Generates a pricing map for EC2 instances by reading .github/scale-config.yml
and fetching current AWS pricing data.
"""

import argparse
import json
import boto3
import yaml


def gen_pricing_map(output_file: str) -> None:
    """Generate pricing map from scale-config.yml and write to output file."""
    with open(".github/scale-config.yml", "r") as f:
        config = yaml.safe_load(f)

    runner_types = config.get("runner_types", {})
    pricing_data = []

    for runner_type, runner_config in runner_types.items():
        instance_type = runner_config.get("instance_type", "")
        os_type = runner_config.get("os", "linux")  # Default to linux if not specified
        price = get_price(instance_type, os_type) or 0.0
        pricing_data.append([runner_type, instance_type, price])

    # Write to file
    with open(output_file, 'w') as f:
        for row in pricing_data:
            f.write(json.dumps(row))
            f.write("\n")

    print(f"Output written to {output_file}")


def get_price(instance_type, os_type="linux") -> float | None:
    """Fetch on-demand price for EC2 instance type using AWS Pricing API. Returns None if not found."""
    # Move the two lines below to the top of the file if you're going to run this function
    client = boto3.client("pricing", region_name="us-east-1")

    # Map os_type to AWS pricing API values
    operating_system = "Windows" if os_type.lower() == "windows" else "Linux"

    resp = client.get_products(
        ServiceCode="AmazonEC2",
        Filters=[
            {"Type": "TERM_MATCH", "Field": "instanceType", "Value": instance_type},
            {"Type": "TERM_MATCH", "Field": "location", "Value": "US East (N. Virginia)"},
            {"Type": "TERM_MATCH", "Field": "operatingSystem", "Value": operating_system},
            {"Type": "TERM_MATCH", "Field": "preInstalledSw", "Value": "NA"},
            {"Type": "TERM_MATCH", "Field": "tenancy", "Value": "Shared"},
            {"Type": "TERM_MATCH", "Field": "capacitystatus", "Value": "Used"},
        ],
        MaxResults=1,
    )

    if not resp["PriceList"]:
        return None

    item = json.loads(resp["PriceList"][0])
    terms = item["terms"]["OnDemand"]
    price_dimensions = next(
        iter(next(iter(terms.values()))["priceDimensions"].values())
    )
    return float(price_dimensions["pricePerUnit"]["USD"])


def main():
    """Parse command-line arguments and generate EC2 pricing map."""
    parser = argparse.ArgumentParser(description="Generate EC2 pricing map from scale-config.yml")
    parser.add_argument(
        "--output", "-o",
        type=str,
        default="ec2_pricing.json",
        help="Output file path (default: ec2_pricing.json)"
    )
    args = parser.parse_args()

    gen_pricing_map(args.output)


if __name__ == "__main__":
    main()
