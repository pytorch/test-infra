# Takes the scale-config.yml file in test-infra/.github/scale-config.yml and runs the following validations against it:
# 1. Internal validation: Ensure that every linux runner type listed has a corresponding runner type with the
#    prefix "amz2023." that contains all the same settings except for the ami
# 2. External validation: Ensure that every runner type listed (linux & windows) have corresponding runner types in
#    pytorch/pytorch's .github/lf-scale-config.yml and .github/lf-canary-scale-config.yml that have the "lf."
#    "lf.c." prefixes added correspondingly
# This script assumes that it is being run from the root of the test-infra repository

import argparse
import os
import tempfile

from typing import Any, cast, Dict

import requests
import yaml

AMAZON_2023_PREFIX = "amz2023."

# Paths relative to their respective repositories
SCALE_CONFIG_PATH = ".github/scale-config.yml"
PYTORCH_LF_SCALE_CONFIG_PATH = ".github/lf-scale-config.yml"
PYTORCH_LF_CANARY_SCALE_CONFIG_PATH = ".github/lf-canary-scale-config.yml"

RUNNER_TYPE_CONFIG_KEY = "runner_types"

GITHUB_PYTORCH_REPO_RAW_URL = "https://raw.githubusercontent.com/pytorch/pytorch/main/"

PREFIX_LF = "lf."
PREFIX_LF_CANARY = "lf.c."

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate scale-config.yml file")

    parser.add_argument(
        "--test-infra-repo-root",
        type=str,
        required=False,
        default=".",
        help="Path to the root of the local test-infra repository. Default is the current directory",
    )
    parser.add_argument(
        "--pytorch-repo-root",
        type=str,
        required=False,
        help="Path to the root of the local pytorch repository. If omitted, uses the "
        "main branch from github pytorch/pytorch",
    )

    return parser.parse_args()


def compare_runner_types(
    runner1_type: str,
    runner1_config: Dict[str, str],
    runner2_type: str,
    runner2_config: Dict[str, str],
    ignore_ami: bool = False,
) -> bool:
    are_same = True

    # see if they have the same set of keys
    # Get they keys that they do not both have:
    keys_not_in_both = set(runner1_config.keys()).symmetric_difference(
        set(runner2_config.keys())
    )
    if len(keys_not_in_both) > 0:
        if len(keys_not_in_both) == 1 and "ami" in keys_not_in_both and ignore_ami:
            pass
        else:
            print(
                f"Runner type {runner1_type} and {runner2_type} do not contain matching configs: "
                f"{keys_not_in_both} is missing"
            )
            are_same = False

    # Check if they have the same values for the same keys
    for key in runner1_config:
        if ignore_ami and key == "ami":
            continue

        if key not in runner2_config:
            continue  # This was already caught in the previous check

        if runner1_config[key] != runner2_config[key]:
            print(
                f"Runner type {runner1_type} and {runner2_type} have different configurations "
                f"for key {key}: {runner1_config[key]} vs {runner2_config[key]}"
            )
            are_same = False

    return are_same


def validate_internal(runner_types: Dict[str, Dict[str, str]]) -> bool:
    errors_found = False

    for runner_type in runner_types:
        # Skip the windows runner types
        if runner_type.startswith("windows"):
            continue

        if not runner_type.startswith("amz2023."):
            base_runner_type = runner_type
            amz2023_runner_type = f"{AMAZON_2023_PREFIX}{runner_type}"

            if amz2023_runner_type not in runner_types:
                print(
                    f"Runner type {base_runner_type} does not have a corresponding {amz2023_runner_type} runner type"
                )
                errors_found = True
                continue

        else:
            base_runner_type = runner_type[len(AMAZON_2023_PREFIX) :]
            amz2023_runner_type = runner_type

            if base_runner_type not in runner_types:
                print(
                    f"Runner type {amz2023_runner_type} does not have a corresponding {base_runner_type} runner type"
                )
                errors_found = True
                continue

        if not compare_runner_types(
            base_runner_type,
            runner_types[base_runner_type],
            amz2023_runner_type,
            runner_types[amz2023_runner_type],
            ignore_ami=True,
        ):
            errors_found = True

    return not errors_found


def validate_across_configs(
    source_config: Dict[str, Dict[str, str]],
    dest_config: Dict[str, Dict[str, str]],
    expected_prefix: str,
) -> bool:
    errors_found = False

    # Every entry in the source_config should be in the dest_config with
    # the same settings, except that the runner_type should have the expected_prefix
    for source_runner_type in source_config:
        dest_runner_type = f"{expected_prefix}{source_runner_type}"

        if dest_runner_type not in dest_config:
            print(
                f"Runner type {source_runner_type} does not have a corresponding {dest_runner_type} runner type"
            )
            errors_found = True
            continue

        if not compare_runner_types(
            source_runner_type,
            source_config[source_runner_type],
            dest_runner_type,
            dest_config[dest_runner_type],
        ):
            errors_found = True

    return not errors_found


def generate_repo_scale_config(
    source_config_file: str, dest_config_file: str, expected_prefix: str
) -> None:
    """
    Generate the new scale config file with the same layout as the original file
    """

    source_config = load_scale_config(source_config_file)
    base_runner_types = set(source_config[RUNNER_TYPE_CONFIG_KEY].keys())

    with open(source_config_file, "r") as f:
        source_config_lines = f.readlines()

    with open(dest_config_file, "w") as f:
        f.write(
            """
# This file is generated by .github/scripts/validate_scale_config.py in test-infra
# It defines runner types that will be provisioned by by LF Self-hosted runners

"""
        )
        for line in source_config_lines:
            # Any line that has a runner type should have the expected prefix added.
            # Otherwise we can just copy the line over
            entry = line.strip(" :\n")
            if entry in base_runner_types:
                # We found a runner type. Give it the expected prefix
                line = line.replace(entry, f"{expected_prefix}{entry}")

            f.write(line)


def load_scale_config(scale_config_path: str) -> Dict[str, Any]:
    # Verify file exists
    if not os.path.exists(scale_config_path):
        print(
            f"Could not find file {scale_config_path}. Please verify the path given on the command line."
        )
        exit(1)

    with open(scale_config_path, "r") as f:
        return cast(Dict[str, Any], yaml.safe_load(f))


def download_file(url: str, local_filename: str) -> None:
    # Send a GET request to the URL
    response = requests.get(url)

    # Raise an exception if the request was unsuccessful
    response.raise_for_status()

    os.makedirs(os.path.dirname(local_filename), exist_ok=True)

    # Write the content to a local file
    with open(local_filename, "wb") as f:
        f.write(response.content)

    print(f"Downloaded file to {local_filename}")


def main() -> None:
    args = parse_args()

    generate_files = False
    temp_dir = None
    if args.pytorch_repo_root is None:
        print(
            "Using github's pytorch/pytorch repository as the source for the pytorch scale config files"
        )

        pytorch_lf_scale_config_url = (
            GITHUB_PYTORCH_REPO_RAW_URL + PYTORCH_LF_SCALE_CONFIG_PATH
        )
        pytorch_lf_canary_scale_config_url = (
            GITHUB_PYTORCH_REPO_RAW_URL + PYTORCH_LF_CANARY_SCALE_CONFIG_PATH
        )

        temp_dir = tempfile.mkdtemp()
        pytorch_lf_scale_config_path = os.path.join(
            temp_dir, PYTORCH_LF_SCALE_CONFIG_PATH
        )
        pytorch_lf_canary_scale_config_path = os.path.join(
            temp_dir, PYTORCH_LF_CANARY_SCALE_CONFIG_PATH
        )

        download_file(pytorch_lf_scale_config_url, pytorch_lf_scale_config_path)
        download_file(
            pytorch_lf_canary_scale_config_url, pytorch_lf_canary_scale_config_path
        )
    else:
        # Running locally
        generate_files = True
        pytorch_lf_scale_config_path = os.path.join(
            args.pytorch_repo_root, PYTORCH_LF_SCALE_CONFIG_PATH
        )
        pytorch_lf_canary_scale_config_path = os.path.join(
            args.pytorch_repo_root, PYTORCH_LF_CANARY_SCALE_CONFIG_PATH
        )

    scale_config_path = os.path.join(args.test_infra_repo_root, SCALE_CONFIG_PATH)

    scale_config = load_scale_config(scale_config_path)
    pytorch_scale_config = load_scale_config(pytorch_lf_scale_config_path)
    pytorch_canary_scale_config = load_scale_config(pytorch_lf_canary_scale_config_path)

    validation_success = True
    print(f"Validating self consistency of {scale_config_path}")
    if not validate_internal(scale_config[RUNNER_TYPE_CONFIG_KEY]):
        validation_success = False
        print("scale-config.yml is not internally consistent\n")

    if generate_files:
        print(f"Generating updated {pytorch_lf_scale_config_path}")
        generate_repo_scale_config(
            scale_config_path, pytorch_lf_scale_config_path, PREFIX_LF
        )

        print(f"Generating updated {pytorch_lf_canary_scale_config_path}")
        generate_repo_scale_config(
            scale_config_path, pytorch_lf_canary_scale_config_path, PREFIX_LF_CANARY
        )

    if not validate_across_configs(
        scale_config[RUNNER_TYPE_CONFIG_KEY],
        pytorch_scale_config[RUNNER_TYPE_CONFIG_KEY],
        PREFIX_LF,
    ):
        print(
            f"Consistency validation failed between {pytorch_scale_config} and {pytorch_lf_scale_config_path}"
        )
        validation_success = False

    if not validate_across_configs(
        scale_config[RUNNER_TYPE_CONFIG_KEY],
        pytorch_canary_scale_config[RUNNER_TYPE_CONFIG_KEY],
        PREFIX_LF_CANARY,
    ):
        print(
            f"Consistency validation failed bewteen {pytorch_scale_config} and {pytorch_lf_canary_scale_config_path}"
        )
        validation_success = False

    # # Delete the temp dir, if it was created
    # if temp_dir and os.path.exists(temp_dir):
    #     os.rmdir(temp_dir)

    if not validation_success:
        print("Validation failed")
        print()
        print(
            "Please run `python .github/scripts/validate_scale_config.py --test-infra-repo-root [path] "
            "--pytorch-repo-root [path]` locally to validate the scale-config.yml file and generate the "
            "updated pytorch scale config files"
        )
        print(
            "If this passes locally and you already have a PR open to update the pytorch scale config "
            "files, you can ignore this failure in CI"
        )
        exit(1)

    exit(0)


if __name__ == "__main__":
    main()
