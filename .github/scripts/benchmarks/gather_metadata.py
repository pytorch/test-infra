#!/usr/bin/env python3
# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
#
# This source code is licensed under the BSD-style license found in the
# LICENSE file in the root directory of this source tree.

import json
import os
import time
from typing import Any


def parse_args() -> Any:
    from argparse import ArgumentParser

    parser = ArgumentParser("gather some metadata about the benchmark")
    # v3 is defined at torchci/clickhouse_queries/oss_ci_benchmark_v3/query.sql
    parser.add_argument(
        "--schema-version",
        choices=["v2", "v3"],
        required=True,
        help="the database schema to use",
    )
    parser.add_argument(
        "--repo",
        type=str,
        required=True,
        help="the name of repository where the benchmark is run",
    )
    parser.add_argument(
        "--head-branch",
        type=str,
        required=True,
        help="the name of branch where the benchmark is run",
    )
    parser.add_argument(
        "--head-sha",
        type=str,
        required=True,
        help="the commit that the benchmark uses",
    )
    parser.add_argument(
        "--workflow-id",
        type=int,
        required=True,
        help="the benchmark workflow id",
    )
    parser.add_argument(
        "--run-attempt",
        type=int,
        default=1,
        help="the workflow run attempt",
    )
    parser.add_argument(
        "--job-id",
        type=int,
        required=True,
        help="the benchmark job id",
    )
    parser.add_argument(
        "--job-name",
        type=str,
        required=True,
        help="the benchmark job name",
    )

    return parser.parse_args()


def set_output(name: str, val: Any) -> None:
    if os.getenv("GITHUB_OUTPUT"):
        with open(str(os.getenv("GITHUB_OUTPUT")), "a") as env:
            print(f"{name}={val}", file=env)
    else:
        print(f"::set-output name={name}::{val}")


def main() -> None:
    args = parse_args()

    # From https://github.com/pytorch/test-infra/pull/5839
    metadata = {
        "timestamp": int(time.time()),
        "schema_version": args.schema_version,
        "name": args.job_name,
        "repo": args.repo,
        "head_branch": args.head_branch,
        "head_sha": args.head_sha,
        "workflow_id": args.workflow_id,
        "run_attempt": args.run_attempt,
        "job_id": args.job_id,
    }
    set_output("metadata", json.dumps(metadata))


if __name__ == "__main__":
    main()
