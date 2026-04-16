#!/usr/bin/env python3

"""Generates a matrix for docker releases through github actions

Will output a condensed version of the matrix. Will include fllowing:
    * CUDA version short
    * CUDA full version
    * CUDNN version short
    * Image type either runtime or devel
    * Platform linux/arm64,linux/amd64

"""

import argparse
import json
import os
import sys
from datetime import datetime
from typing import Dict, List

import generate_binary_build_matrix


DOCKER_IMAGE_TYPES = ["runtime", "devel"]


def generate_docker_matrix(
    channel: str, generate_dockerhub_images: str
) -> Dict[str, List[Dict[str, str]]]:
    ret: List[Dict[str, str]] = []
    prefix = "ghcr.io/pytorch/pytorch"
    docker_image_version = ""
    if channel == "release":
        prefix_for_release = (
            prefix.replace("ghcr.io/", "")
            if generate_dockerhub_images == "true"
            else prefix
        )
        docker_image_version = f"{prefix_for_release}:{generate_binary_build_matrix.CURRENT_STABLE_VERSION}"
    elif channel == "test":
        docker_image_version = (
            f"{prefix}-test:{generate_binary_build_matrix.CURRENT_CANDIDATE_VERSION}"
        )
    else:
        docker_image_version = f"{prefix}-nightly:{generate_binary_build_matrix.CURRENT_NIGHTLY_VERSION}.dev{datetime.today().strftime('%Y%m%d')}"

    for cuda in generate_binary_build_matrix.CUDA_ARCHES_DICT[channel]:
        version = generate_binary_build_matrix.CUDA_CUDNN_VERSIONS[cuda]
        for image in DOCKER_IMAGE_TYPES:
            ret.append(
                {
                    "cuda": cuda,
                    "cuda_full_version": version["cuda"],
                    "cudnn_version": version["cudnn"],
                    "image_type": image,
                    "docker": f"{docker_image_version}-cuda{cuda}-cudnn{version['cudnn']}-{image}",
                    "platform": "linux/amd64",
                    "validation_runner": generate_binary_build_matrix.LINUX_GPU_RUNNER,
                }
            )

    ret.append(
        {
            "cuda": "cpu",
            "cuda_full_version": "",
            "cudnn_version": "",
            "image_type": "runtime",
            "docker": f"{docker_image_version}-runtime",
            "platform": "linux/arm64",
            "validation_runner": generate_binary_build_matrix.LINUX_AARCH64_RUNNER,
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
    parser.add_argument(
        "--generate_dockerhub_images",
        help="Whether to generate Docker Hub images (default: False)",
        type=str,
        choices=["true", "false"],
        default=os.getenv("GENERATE_DOCKER_HUB_IMAGES", "false"),
    )
    options = parser.parse_args()

    build_matrix = generate_docker_matrix(
        options.channel, options.generate_dockerhub_images
    )
    print(json.dumps(build_matrix))


if __name__ == "__main__":
    main()
