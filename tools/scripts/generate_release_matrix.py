#!/usr/bin/env python3

"""Generates a release matrix to be utilized through github actions

Will output a JSON representing PyTorch Release versions. To be used with validation framework.

"""


import argparse
import json
import sys
from typing import Dict

mod = sys.modules[__name__]

RELEASE_DICT = {
    "2.1.0": { 'torch': '2.1.0', 'torchvision': '0.16.0', 'torchaudio': '2.1.0', 'torchtext': '0.16.0', 'tochdata': '0.7.0'},
    "2.1.1": { 'torch': '2.1.1', 'torchvision': '0.16.1', 'torchaudio': '2.1.1', 'torchtext': '0.16.1', 'tochdata': '0.7.1'}
}


def main(args) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--version",
        help="PyTorch Release version",
        type=str,
        default=os.getenv("VERSION", "2.1.1"),
    )

    options = parser.parse_args(args)

    if options.version not in RELEASE_DICT.keys():
        raise ValueError(f"{options.version} is not a valid release")

    print(json.dumps(RELEASE_DICT[options.version]))


if __name__ == "__main__":
    main(sys.argv[1:])
