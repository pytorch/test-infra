"""Runs the API backward compatibility on the head commit."""

import argparse
import pathlib
import sys

import api.compatibility
import api.git
import api.github


def run() -> None:
    parser = argparse.ArgumentParser(prog=sys.argv[0], description=__doc__)
    parser.add_argument('--base-commit', type=str, required=True)
    parser.add_argument('--head-commit', type=str, required=True)
    args = parser.parse_args(sys.argv[1:])

    repo = api.git.Repository(pathlib.Path('.'))

    # By default, our GitHub jobs only fetch to a depth of one. This
    # means that the base commit will not be known to our local
    # clone. We must fetch it in order to compare head and base.
    repo.run(['fetch', 'origin', args.base_commit], check=True)

    violations = api.compatibility.check_range(
        repo, head=args.head_commit, base=args.base_commit
    )
    if len(violations) == 0:
        return
    for file, file_violations in violations.items():
        for violation in file_violations:
            print(api.github.render_violation(file, violation), file=sys.stderr)
    sys.exit(1)
