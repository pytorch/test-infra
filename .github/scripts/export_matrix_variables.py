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
    parser.add_argument(
        "--operating-system",
        help="Operating system to generate for",
        type=str,
        default="linux",
    )
    options = parser.parse_args(args)

    with open(options.input_file) as fp:
        variables_to_export: Dict[str, str] = json.loads(fp.read())

    if options.operating_system == "linux":
        for key, value in variables_to_export.items():
            print(
                f"MATRIX_{key.upper().replace('-', '_')}={value.replace('-', '_')}"
            )
    elif options.operating_system == "windows":
        import subprocess
        for key, value in variables_to_export.items():
            subprocess.call(['setx', f"MATRIX_{key.upper().replace('-', '_')}", f"{value.replace('-', '_')}"], shell=True)


if __name__ == "__main__":
    main(sys.argv[1:])
