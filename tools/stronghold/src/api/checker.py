"""Runs the API backward compatibility on the head commit."""

import argparse
import pathlib
import pprint
import sys

import api.compatibility
import api.git


def run() -> None:
    parser = argparse.ArgumentParser(prog=sys.argv[0], description=__doc__)
    parser.add_argument('--base_sha', type=str, required=True)
    parser.add_argument('--head_sha', type=str, required=True)
    args = parser.parse_args(sys.argv[1:])

    repo = api.git.Repository(pathlib.Path('.'))
    violations = api.compatibility.check_range(repo, head=args.head_sha, base=args.base_sha)
    if len(violations) == 0:
        return
    for file, file_violations in violations.items():
        print(file)
        pprint.pp(file_violations)
    sys.exit(1)
