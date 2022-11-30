#!/usr/bin/env python

import argparse
import json

from typing import Dict


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create variables for usage within generic Github Actions workflows"
    )
    parser.add_argument("input_file", help="Input file to use, must be JSON")
    return parser.parse_args()


def main(input_file: str) -> None:
    with open(input_file) as fp:
        variables_to_export: Dict[str, str] = json.loads(fp.read())
    for key, value in variables_to_export.items():
        print(
            f"MATRIX_{key.upper().replace('-', '_')}={value.upper().replace('-', '_')}"
        )


if __name__ == "__main__":
    args = parse_args()
    main(args.input_file)
