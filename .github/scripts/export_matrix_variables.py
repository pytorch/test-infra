#!/usr/bin/env python
import argparse
import json
import sys
from typing import Dict

def main(args) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input-file",
        help="Input file to use, must be JSON",
        type=str,
    )
    options = parser.parse_args(args)

    with open(options.input_file) as fp:
        variables_to_export: Dict[str, str] = json.loads(fp.read())

    for key, value in variables_to_export.items():
        print(
            f"MATRIX_{key.upper().replace('-', '_')}=\"{value}\""
        )

if __name__ == "__main__":
    main(sys.argv[1:])
