#!/usr/bin/env python3
"""
EC2 Pricing Map Generator

Generates a pricing map for EC2 instances by reading .github/scale-config.yml
and fetching current AWS pricing data.
"""

import argparse
import json
from functools import lru_cache
from typing import Optional

import requests
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
    with open(output_file, "w") as f:
        for row in pricing_data:
            f.write(json.dumps(row))
            f.write("\n")

    print(f"Output written to {output_file}")


@lru_cache
def get_all_pricing_data() -> dict:
    """Fetch the entire EC2 pricing data from AWS pricing API.  Cached for efficiency."""
    price_list_url = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-1/index.json"
    response = requests.get(price_list_url)
    response.raise_for_status()
    return response.json()


def get_price(instance_type, os_type="linux") -> Optional[float]:
    """Fetch on-demand price for EC2 instance type using AWS public pricing data. Returns None if not found."""

    # Map os_type to AWS pricing API values
    operating_system = "Windows" if os_type.lower() == "windows" else "Linux"

    # Get the cached pricing data
    pricing_data = get_all_pricing_data()

    # Search through the products to find matching instance
    for product_sku, product_data in pricing_data.get("products", {}).items():
        attributes = product_data.get("attributes", {})

        if (
            attributes.get("instanceType") == instance_type
            and attributes.get("location") == "US East (N. Virginia)"
            and attributes.get("operatingSystem") == operating_system
            and attributes.get("preInstalledSw") == "NA"
            and attributes.get("tenancy") == "Shared"
            and attributes.get("usagetype", "").startswith("BoxUsage")
        ):
            # Found the product, now get the pricing terms
            terms = (
                pricing_data.get("terms", {}).get("OnDemand", {}).get(product_sku, {})
            )

            for term_data in terms.values():
                price_dimensions = term_data.get("priceDimensions", {})
                for price_data in price_dimensions.values():
                    price_per_unit = price_data.get("pricePerUnit", {}).get("USD")
                    if price_per_unit:
                        return float(price_per_unit)

    print(f"No pricing found for {instance_type} ({operating_system})")
    return None


def main():
    """Parse command-line arguments and generate EC2 pricing map."""
    parser = argparse.ArgumentParser(
        description="Generate EC2 pricing map from scale-config.yml"
    )
    parser.add_argument(
        "--output",
        "-o",
        type=str,
        default="ec2_pricing.json",
        help="Output file path (default: ec2_pricing.json)",
    )
    args = parser.parse_args()

    gen_pricing_map(args.output)


if __name__ == "__main__":
    main()
