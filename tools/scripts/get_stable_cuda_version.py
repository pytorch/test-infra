#!/usr/bin/env python3

"""Return stable CUDA version for the current channel"""

import argparse
import json
import os
import sys
from typing import List


def main(args: List[str]) -> None:
    import generate_binary_build_matrix

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--channel",
        help="Channel to use, default nightly",
        type=str,
        choices=["nightly", "test", "release"],
        default=os.getenv("CHANNEL", "nightly"),
    )
    options = parser.parse_args(args)
    print(generate_binary_build_matrix.STABLE_CUDA_VERSIONS[options.channel])


if __name__ == "__main__":
    main(sys.argv[1:])
