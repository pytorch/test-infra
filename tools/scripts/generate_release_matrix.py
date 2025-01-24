#!/usr/bin/env python3

"""Generates a release matrix to be utilized through github actions

Will output a JSON representing PyTorch Release versions. To be used with validation framework.

"""

import argparse
import json
import os
import sys
from typing import Dict, List


mod = sys.modules[__name__]

RELEASE_DICT = {
    "2.1.0": {
        "torch": "2.1.0",
        "torchvision": "0.16.0",
        "torchaudio": "2.1.0",
        "torchtext": "0.16.0",
        "torchdata": "0.7.0",
    },
    "2.1.1": {
        "torch": "2.1.1",
        "torchvision": "0.16.1",
        "torchaudio": "2.1.1",
        "torchtext": "0.16.1",
        "torchdata": "0.7.1",
    },
    "2.1.2": {
        "torch": "2.1.2",
        "torchvision": "0.16.2",
        "torchaudio": "2.1.2",
        "torchtext": "0.16.2",
        "torchdata": "0.7.1",
    },
    "2.2.0": {
        "torch": "2.2.0",
        "torchvision": "0.17.0",
        "torchaudio": "2.2.0",
        "torchtext": "0.17.0",
        "torchdata": "0.7.1",
    },
    "2.2.1": {
        "torch": "2.2.1",
        "torchvision": "0.17.1",
        "torchaudio": "2.2.1",
        "torchtext": "0.17.1",
        "torchdata": "0.7.1",
    },
    "2.2.2": {
        "torch": "2.2.2",
        "torchvision": "0.17.2",
        "torchaudio": "2.2.2",
        "torchtext": "0.17.2",
        "torchdata": "0.7.1",
    },
    "2.3.0": {
        "torch": "2.3.0",
        "torchvision": "0.18.0",
        "torchaudio": "2.3.0",
        "torchtext": "0.18.0",
        "torchdata": "0.7.1",
    },
    "2.3.1": {
        "torch": "2.3.1",
        "torchvision": "0.18.1",
        "torchaudio": "2.3.1",
        "torchtext": "0.18.1",
        "torchdata": "0.7.1",
    },
    "2.4.0": {
        "torch": "2.4.0",
        "torchvision": "0.19.0",
        "torchaudio": "2.4.0",
        "torchtext": "0.18.1",
        "torchdata": "0.7.1",
    },
    "2.4.1": {
        "torch": "2.4.1",
        "torchvision": "0.19.1",
        "torchaudio": "2.4.1",
        "torchtext": "0.18.1",
        "torchdata": "0.7.1",
    },
    "2.5.0": {
        "torch": "2.5.0",
        "torchvision": "0.20.0",
        "torchaudio": "2.5.0",
        "torchtext": "0.18.1",
        "torchdata": "0.7.1",
    },
    "2.5.1": {
        "torch": "2.5.1",
        "torchvision": "0.20.1",
        "torchaudio": "2.5.1",
        "torchtext": "0.18.1",
        "torchdata": "0.7.1",
    },
}


def main(args: List[str]) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--version",
        help="PyTorch Release version",
        type=str,
        default=os.getenv("VERSION", ""),
    )
    options = parser.parse_args(args)

    if options.version and options.version not in RELEASE_DICT.keys():
        raise ValueError(f"{options.version} is not a valid release")
    elif options.version:
        print(json.dumps(RELEASE_DICT[options.version]))
    else:
        print(json.dumps({}))


if __name__ == "__main__":
    main(sys.argv[1:])
