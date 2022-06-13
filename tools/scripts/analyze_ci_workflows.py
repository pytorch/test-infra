#!/usr/bin/env python

import argparse
import yaml
import collections
import typing

import re


OS_JOB_TYPES = {
    "android": re.compile(r".*android.*"),
    "ios": re.compile(r".*ios.*"),
    "linux_cuda (build)": re.compile(r"^linux-.*cuda.*build"),
    "linux_cuda (test)": re.compile(r"^linux-.*cuda.*test"),
    "linux_rocm (build)": re.compile(r"^linux-.*rocm.*build"),
    "linux_rocm (test)": re.compile(r"^linux-.*rocm.*test"),
    "linux_cpu (build)": re.compile(r"^linux-.*build"),
    "linux_cpu (test)": re.compile(r"^linux-.*test"),
    "windows_cuda (build)": re.compile(r"^win-.*cuda.*build"),
    "windows_cuda (test)": re.compile(r"^win-.*cuda.*test"),
    "windows_cpu (build)": re.compile(r"^win-.*build"),
    "windows_cpu (test)": re.compile(r"^win-.*test"),
    "macos (build)": re.compile(r"^macos-.*build"),
    "macos (test)": re.compile(r"^macos-.*test"),
}

COMPILER_JOB_TYPES = {
    "clang": re.compile(r".*(clang|macos).*build.*"),
    "gcc": re.compile(r".*gcc.*build.*"),
    "visual studio": re.compile(r".*win.*build.*"),
}

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Analyze operating system support for github actions workflow files"
    )
    parser.add_argument(
        "workflow_files",
        help="Workflow file(s) to anaylze",
        nargs="+",
        type=str,
    )
    return parser.parse_args()

def do_analysis(name: str, workflow_jobs: typing.List[str], job_types: typing.Dict[str, re.Pattern]) -> None:
    analysis = collections.defaultdict(int)
    for workflow_job in workflow_jobs:
        for job_type, job_type_pattern in job_types.items():
            if job_type_pattern.match(workflow_job):
                analysis[job_type] += 1
                break

    print(f"= {name} =")
    for job_type, job_count in sorted(analysis.items()):
        print(f"{job_count:>10} {job_type:<10}")
    print()


def main() -> None:
    options = parse_args()
    workflow_jobs = list()
    for workflow_file in options.workflow_files:
        with open(workflow_file, "r") as fp:
            workflow = yaml.load(fp.read(), Loader=yaml.Loader)
            workflow_jobs.extend(workflow["jobs"].keys())
    do_analysis("By Operating System / Hardware Accelerator", workflow_jobs, OS_JOB_TYPES)
    do_analysis("By Compiler", workflow_jobs, COMPILER_JOB_TYPES)

if __name__ == "__main__":
    main()
