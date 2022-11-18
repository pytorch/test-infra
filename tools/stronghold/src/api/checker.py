"""Runs the API backward compatibility on the head commit."""

import argparse
import os
import pathlib
import sys

import api.compatibility
import api.git


def run() -> None:
    parser = argparse.ArgumentParser(prog=sys.argv[0], description=__doc__)
    parser.parse_args(sys.argv[1:])

    repo = api.git.Repository(pathlib.Path('.'))
    import pprint

    pprint.pp(os.environ)
    api.compatibility.check_range(
        repo, head=os.environ['GITHUB_HEAD_REF'], base=os.environ['GITHUB_BASE_REF']
    )
