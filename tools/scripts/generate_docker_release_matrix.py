#!/usr/bin/env python3

"""Generates a matrix for docker releases through github actions

Will output a condensed version of the matrix. Will include fllowing:
    * CUDA version short
    * CUDA full version
    * CUDNN version short
    * Image type either runtime or devel
    * Platform linux/arm64,linux/amd64

"""

import json
import os
import sys
import argparse
from typing import Dict, List
from datetime import datetime

import generate_binary_build_matrix

DOCKER_IMAGE_TYPES = ["runtime", "devel"]


def generate_docker_matrix(channel: str) -> Dict[str, List[Dict[str, str]]]:

    ret: List[Dict[str, str]] = []
    for cuda in generate_binary_build_matrix.CUDA_ARCHES_DICT[channel]:
        version = generate_binary_build_matrix.CUDA_CUDDN_VERSIONS[cuda]

        prefix = "ghcr.io/pytorch/pytorch"
        docker_image_version = ""
        if channel == "release":
            docker_image_version = f"{prefix}:{generate_binary_build_matrix.CURRENT_STABLE_VERSION}"
        elif channel == "test":
            docker_image_version = f"{prefix}-test:{generate_binary_build_matrix.CURRENT_CANDIDATE_VERSION}"
        else:
            docker_image_version = f"{prefix}-nightly:{generate_binary_build_matrix.CURRENT_NIGHTLY_VERSION}.dev{datetime.today().strftime('%Y%m%d')}"

        for image in DOCKER_IMAGE_TYPES:
            ret.append(
                {
                    "cuda": cuda,
                    "cuda_full_version": version["cuda"],
                    "cudnn_version": version["cudnn"],
                    "image_type": image,
                    "docker": f"{docker_image_version}-cuda{cuda}-cudnn{version['cudnn']}-{image}",
                    "platform": "linux/arm64,linux/amd64",
                }
            )
    return {"include": ret}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--channel",
        help="Channel to use, default nightly",
        type=str,
        choices=["nightly", "test", "release", "all"],
        default=os.getenv("CHANNEL", "nightly"),
    )
    options = parser.parse_args()

    build_matrix = generate_docker_matrix(options.channel)
    print(json.dumps(build_matrix))

if __name__ == "__main__":
    main()
