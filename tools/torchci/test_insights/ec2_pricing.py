#!/usr/bin/env python3
"""
EC2 Pricing Map Generator

Get pricing info for EC2 instances by reading .github/scale-config.yml and
fetching current AWS pricing data.
"""

import json
from functools import lru_cache
from typing import Optional

import requests
import yaml


@lru_cache
def _get_scale_config() -> dict:
    """Load scale-config.yml and return as a dictionary."""
    with open(".github/scale-config.yml", "r") as f:
        config = yaml.safe_load(f)
    return config


def get_ec2_instance_for_label(label: str) -> dict[str, Optional[str]]:
    """Get EC2 instance type for a given GitHub Actions runner label from scale-config.yml."""
    config = _get_scale_config()

    runner_info = config.get("runner_types", {})

    if label in runner_info:
        return {
            "ec2_instance": runner_info[label].get("instance_type", None),
            "os": runner_info[label].get("os", "linux"),
        }  # Default to linux if not specified
    return {"ec2_instance": None, "os": None}


@lru_cache
def get_all_pricing_data() -> dict:
    """Fetch the entire EC2 pricing data from AWS pricing API.  Cached for efficiency."""
    price_list_url = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-1/index.json"
    response = requests.get(price_list_url)
    response.raise_for_status()
    return response.json()


@lru_cache
def get_price_for_ec2_instance(instance_type, os_type="linux") -> Optional[float]:
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


@lru_cache
def get_price_for_label(label: str) -> Optional[float]:
    """Get the on-demand price for the EC2 instance type associated with the given GitHub Actions runner label."""
    instance_info = get_ec2_instance_for_label(label)
    instance_type = instance_info["ec2_instance"]
    os_type = instance_info["os"]
    if instance_type is not None:
        return get_price_for_ec2_instance(instance_type, os_type)
    return None


if __name__ == "__main__":
    # Example usage
    info = []
    scale_config = _get_scale_config()
    for runner_label in scale_config.get("runner_types", {}):
        price = get_price_for_label(runner_label)
        info.append(
            {
                "label": runner_label,
                "price_per_hour": price,
                "instance_type": get_ec2_instance_for_label(runner_label)[
                    "ec2_instance"
                ],
            }
        )
    with open("ec2_pricing.json", "w") as f:
        for line in info:
            json.dump(line, f)
            f.write("\n")
