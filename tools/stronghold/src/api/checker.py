"""Runs the API backward compatibility on the head commit."""

import argparse
import pathlib
import subprocess
import sys

import api.compatibility
import api.git
import api.github


def run() -> None:
    parser = argparse.ArgumentParser(prog=sys.argv[0], description=__doc__)
    parser.add_argument('--base-commit', type=str, required=True)
    parser.add_argument('--head-commit', type=str, required=True)
    parser.add_argument(
        '--suppressed',
        default=False,
        required=False,
        action='store_true',
        help='Failures are suppressed'
        '(alternative to #suppress-api-compatibility-check commit message tag).',
    )
    args = parser.parse_args(sys.argv[1:])

    repo = api.git.Repository(pathlib.Path('.'))

    # By default, our GitHub jobs only fetch to a depth of one. This
    # means that the base commit will not be known to our local
    # clone. We must fetch it in order to compare head and base.
    #
    # The fetch is a smidge noisy, hide it by default.
    print('::group::fetch github.event.pull_request.base.sha')
    repo.run(['fetch', 'origin', args.base_commit], check=True)
    print('::endgroup::')

    violations = api.compatibility.check_range(
        repo, head=args.head_commit, base=args.base_commit
    )
    if len(violations) == 0:
        return

    pinfo = repo.run(
        [
            'show',
            # Don't show the file contents.
            '--no-patch',
            # Show the title and the full commit message.
            '--pretty=format:%B',
        ],
        check=True,
        stdout=subprocess.PIPE,
    )
    suppression_tags = ['#suppress-api-compatibility-check', '#suppress-bc-linter']
    suppressed = args.suppressed or any(tag in pinfo.stdout for tag in suppression_tags)
    level = 'notice' if suppressed else 'warning'

    for file, file_violations in violations.items():
        for violation in file_violations:
            print(api.github.render_violation(level, file, violation), file=sys.stderr)
    sys.exit(not suppressed)
