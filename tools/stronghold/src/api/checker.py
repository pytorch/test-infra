"""Runs the API backward compatibility on the head commit."""

import argparse
import pathlib
import sys

import api.compatibility
import api.git


def run() -> None:
    parser = argparse.ArgumentParser(prog=sys.argv[0], description=__doc__)
    parser.parse_args(sys.argv[1:])

    repo = api.git.Repository(pathlib.Path('.'))
    api.compatibility.check_range(repo, head='HEAD', base='HEAD~')
