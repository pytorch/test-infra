from typing import Any

import boto3  # type: ignore[import]


def parse_args() -> Any:
    from argparse import ArgumentParser

    parser = ArgumentParser("Upload file to ossci-metrics bucket")
    parser.add_argument("filepath", type=str)
    return parser.parse_args()


def main(file_path: str) -> None:
    obj = boto3.resource("s3").Object("ossci-metrics", file_path)
    with open(file_path) as f:
        obj.put(Body=f.read().encode())


if __name__ == "__main__":
    args = parse_args()
    main(args.filepath)
