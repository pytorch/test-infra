# Takes the scale-config.yml file in test-infra/.github/scale-config.yml and runs the following
# validations against it:
# 1. Internal validation: Runs a custom set of sanity checks against the runner types defined in the file
# 2. External validation: Ensure that every runner type listed (linux & windows) have corresponding runner types in
#    the Linux Foundation fleet's scale config files (.github/lf-scale-config.yml and .github/lf-canary-scale-config.yml).
#    Those files are expected to have the "lf." and "lf.c." prefixes added to each runner type

import argparse
import copy
import json
import os
import urllib.request
from pathlib import Path
from typing import Any, cast, Dict, List, NamedTuple, Union

import jsonschema  # type: ignore[import-untyped]
import yaml


MAX_AVAILABLE_MINIMUM = 50

# Paths relative to their respective repositories
META_SCALE_CONFIG_PATH = ".github/scale-config.yml"
META_CANARY_SCALE_CONFIG_PATH = ".github/canary-scale-config.yml"
LF_SCALE_CONFIG_PATH = ".github/lf-scale-config.yml"
LF_CANARY_SCALE_CONFIG_PATH = ".github/lf-canary-scale-config.yml"

RUNNER_TYPE_CONFIG_KEY = "runner_types"

PREFIX_META = ""
PREFIX_META_CANARY = "c."
PREFIX_LF = "lf."
PREFIX_LF_CANARY = "lf.c."

_RUNNER_BASE_JSCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "ami_experiment": {"type": "object"},
        "ami": {"type": "string"},
        "disk_size": {"type": "number"},
        "instance_type": {"type": "string"},
        "is_ephemeral": {"type": "boolean"},
        "labels": {"type": "array", "items": {"type": "string"}},
        "min_available": {"type": "number"},
        "max_available": {"type": "number"},
        "os": {"type": "string", "enum": ["linux", "windows"]},
    },
}

RUNNER_JSCHEMA = copy.deepcopy(_RUNNER_BASE_JSCHEMA)
RUNNER_JSCHEMA["properties"]["variants"] = {  # type: ignore[index]
    "type": "object",
    "patternProperties": {
        "^[a-zA-Z0-9]+$": _RUNNER_BASE_JSCHEMA,
    },
    "additionalProperties": False,
}
RUNNER_JSCHEMA["required"] = [
    "disk_size",
    "instance_type",
    "is_ephemeral",
    "os",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate scale-config.yml file")

    parser.add_argument(
        "--generate",
        "-g",
        action="store_true",
        help="Update the generated scale configs based on the source scale config",
    )

    return parser.parse_args()


def get_repo_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


def runner_types_are_equivalent(
    runner1_type: str,
    runner1_config: Dict[str, str],
    runner2_type: str,
    runner2_config: Dict[str, str],
) -> bool:
    are_same = True

    # See if they have the same set of keys, potentially excluding the ami.
    # Get they keys that they do not both have:
    keys_not_in_both = set(runner1_config.keys()).symmetric_difference(
        set(runner2_config.keys())
    )

    if keys_not_in_both:
        is_are = "is" if len(keys_not_in_both) == 1 else "are"
        print(
            f"Runner type {runner1_type} and {runner2_type} do not contain matching configs: "
            f"{keys_not_in_both} {is_are} missing"
        )
        are_same = False

    # Check if they have the same values for the same keys
    for key in runner1_config:
        if key not in runner2_config:
            continue  # This was already caught in the previous check

        if key == "labels":
            # Labels are defined as list, used as list in every part of the autoscale app,
            # but interpreted as set by the github daemon
            if set(runner1_config[key]) != set(runner2_config[key]):
                print(
                    f"Runner type {runner1_type} and {runner2_type} have different additional labels: "
                    f"{runner1_config[key]} vs {runner2_config[key]}"
                )
                are_same = False

        elif key in {"variants", "ami_experiment"}:
            # These are dictionaries, so we need to compare them as JSON strings
            if json.dumps(runner1_config[key], sort_keys=True) != json.dumps(
                runner2_config[key], sort_keys=True
            ):
                print(
                    f"Runner type {runner1_type} and {runner2_type} have different '{key}' "
                    f"{runner1_config[key]} vs {runner2_config[key]}"
                )
                are_same = False

        elif runner1_config[key] != runner2_config[key]:
            print(
                f"Runner type {runner1_type} and {runner2_type} have different configurations "
                f"for key {key}: {runner1_config[key]} vs {runner2_config[key]}"
            )
            are_same = False

    return are_same


def is_config_valid_internally(
    runner_types: Dict[str, Dict[str, Union[int, str, dict]]],
) -> bool:
    """
    Ensure that for every linux runner type in the config:

    1 - they match RunnerTypeScaleConfig https://github.com/pytorch/test-infra/blob/f3c58fea68ec149391570d15a4d0a03bc26fbe4f/terraform-aws-github-runner/modules/runners/lambdas/runners/src/scale-runners/runners.ts#L50
    2 - they have a max_available of at least 50, or is not enforced
    3 - a ephemeral variant is defined
    """
    invalid_runners = set()

    for runner_type, runner_config in runner_types.items():
        try:
            jsonschema.validate(runner_config, RUNNER_JSCHEMA)
        except jsonschema.ValidationError as e:
            print(f"Runner type {runner_type} has invalid configuration: {e.message}")
            invalid_runners.add(runner_type)
            # continue, as the syntax is invalid and we can't trust the rest of the config
            # so the next part of the code might break
            continue

        # Unecessary validations, that could be a simple onliner, but Code scanning / lintrunner
        # is mercerless and will complain about it
        if "variants" not in runner_config:
            print(f"Runner type {runner_type} does not have a variants section defined")
            invalid_runners.add(runner_type)
            continue
        if not isinstance(runner_config["variants"], dict):
            print(
                f"Runner type {runner_type} has a variants section that is not a dictionary"
            )
            invalid_runners.add(runner_type)
            continue

        ephemeral_variant: Union[None, dict] = runner_config["variants"].get(
            "ephemeral", None
        )

        if ephemeral_variant is None:
            print(
                f"Runner type {runner_type} does not have an ephemeral variant defined"
            )
            invalid_runners.add(runner_type)
            continue
        else:
            if not ephemeral_variant.get(
                "is_ephemeral", False
            ) and not runner_config.get("is_ephemeral", False):
                print(
                    f"Runner type {runner_type} has an ephemeral variant that is not ephemeral"
                )
                invalid_runners.add(runner_type)
                continue

        # Ensure that the max_available is at least MAX_AVAILABLE_MINIMUM
        # this is a requirement as scale-up always keeps at minimum some spare runners live, and less than MAX_AVAILABLE_MINIMUM
        # will very easily trigger alerts of not enough runners
        if "max_available" not in runner_config:
            continue

        if runner_config["max_available"] == None:
            print(
                f"Runner type {runner_type} can't have max_available set to Null, Python, "
                "between other cases, will load a value as None when its property is "
                "defined as null in the yaml file. It is preferable to remove the max_available "
                "property or set it to a negative value."
            )
            invalid_runners.add(runner_type)
        # This validation is absolute not necessary, as it is being validated on the jsonschema
        # but it is here to make the code scanner happy
        elif not isinstance(runner_config["max_available"], int):
            print(
                f"Runner type {runner_type} has max_available set to {runner_config['max_available']}, "
                "which is not an integer"
            )
            invalid_runners.add(runner_type)
        elif (
            runner_config["max_available"] < MAX_AVAILABLE_MINIMUM
            and runner_config["max_available"] >= 0
        ):
            print(
                f"Runner type {runner_type} has max_available set to {runner_config['max_available']}, "
                f"which is less than the minimum required value of {MAX_AVAILABLE_MINIMUM}"
            )
            invalid_runners.add(runner_type)

    if invalid_runners:
        invalid_runners_str = ", ".join(invalid_runners)
        print(
            f"Found a total of {len(invalid_runners)} invalid runner configurations: {invalid_runners_str}"
        )

    return not invalid_runners


def is_consistent_across_configs(
    source_config: Dict[str, Dict[str, str]],
    dest_config: Dict[str, Dict[str, str]],
    expected_prefix: str,
) -> bool:
    """
    Validate that every runner type in the source_config has a corresponding runner type in the dest_config
    where the dest_config has the expected_prefix added
    """
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

        errors_found |= not runner_types_are_equivalent(
            source_runner_type,
            source_config[source_runner_type],
            dest_runner_type,
            dest_config[dest_runner_type],
        )

    return not errors_found


def generate_repo_scale_config(
    source_config_file: Path, dest_config_file: Path, expected_prefix: str
) -> None:
    """
    Generate the new scale config file with the same layout as the original file,
    but with the expected_prefix added to the runner types
    """
    source_config = load_yaml_file(source_config_file)
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


def load_yaml_file(scale_config_path: Path) -> Dict[str, Any]:
    # Verify file exists
    if not scale_config_path.exists():
        print(
            f"Could not find file {scale_config_path}. Please verify the path given on the command line."
        )
        exit(1)

    with open(scale_config_path, "r") as f:
        return cast(Dict[str, Any], yaml.safe_load(f))


def download_file(url: str, local_filename: str) -> None:
    with urllib.request.urlopen(url) as response:
        content = response.read()

    os.makedirs(os.path.dirname(local_filename), exist_ok=True)

    # Write the content to a local file
    with open(local_filename, "wb") as f:
        f.write(content)


class ScaleConfigInfo(NamedTuple):
    path: Path  # full path to scale config file
    prefix: str  # prefix this fleet's runners types should have


def main() -> None:
    repo_root = get_repo_root()

    args = parse_args()

    source_scale_config_info = ScaleConfigInfo(
        path=repo_root / META_SCALE_CONFIG_PATH,
        prefix=PREFIX_META,
    )

    # Contains scale configs that are generated from the source scale config
    generated_scale_config_infos: List[ScaleConfigInfo] = [
        ScaleConfigInfo(
            path=repo_root / META_CANARY_SCALE_CONFIG_PATH,
            prefix=PREFIX_META_CANARY,
        ),
        ScaleConfigInfo(
            path=repo_root / LF_SCALE_CONFIG_PATH,
            prefix=PREFIX_LF,
        ),
        ScaleConfigInfo(
            path=repo_root / LF_CANARY_SCALE_CONFIG_PATH,
            prefix=PREFIX_LF_CANARY,
        ),
    ]

    source_scale_config = load_yaml_file(source_scale_config_info.path)
    validation_success = True

    validation_success = is_config_valid_internally(
        source_scale_config[RUNNER_TYPE_CONFIG_KEY]
    )
    print(f"scaled-config.yml is {'valid' if validation_success else 'invalid'}\n")

    def validate_config(generated_config_info: ScaleConfigInfo) -> bool:
        if args.generate:
            print(f"Generating updated {generated_config_info.path}")

            generate_repo_scale_config(
                source_scale_config_info.path,
                generated_config_info.path,
                generated_config_info.prefix,
            )

        cloned_scale_config = load_yaml_file(generated_config_info.path)

        if not is_consistent_across_configs(
            source_scale_config[RUNNER_TYPE_CONFIG_KEY],
            cloned_scale_config[RUNNER_TYPE_CONFIG_KEY],
            generated_config_info.prefix,
        ):
            print(
                f"Consistency validation failed between {source_scale_config_info.path} and {generated_config_info.path}\n"
            )
            return False
        else:
            print(f"scale-config.yml is consistent with {generated_config_info.path}\n")
            return True

    for cloned_config_info in generated_scale_config_infos:
        validation_success &= validate_config(cloned_config_info)

    if not validation_success:
        print(
            "Validation failed\n\n"
            "Please run `python .github/scripts/validate_scale_config.py --generate` "
            "locally to validate the scale-config.yml file and generate the updated "
            "variant scale config files.\n\n"
            "Note: You still need to fix internal consistency errors yourself.\n\n"
            "If this script passes locally and you already have a PR open on pytorch/pytorch with the "
            " relevant changes, you can merge that pytorch/pytorch PR first to make this job pass."
        )
        exit(1)
    else:
        print("All validations successful")


if __name__ == "__main__":
    main()
