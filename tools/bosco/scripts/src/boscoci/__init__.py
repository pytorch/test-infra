from __future__ import annotations

import argparse
from collections.abc import Collection, MutableSequence, Sequence
import contextlib
import logging
import os
import pathlib
import shlex
import subprocess
import sys
import tempfile
import textwrap


def main(
    *,
    # The commands to run in the environment.
    commands: Sequence[Sequence[str]],
    # Any extra packages that need to be installed to run the
    # command. You can use file system paths, e.g. "." here as well.
    extra_packages: Collection[str] = [],
) -> None:
    """Runs an analysis tool on the Bosco code."""
    parser = argparse.ArgumentParser(sys.argv[0], main.__doc__)

    parser.add_argument(
        '--create-environment',
        type=bool,
        help='If true, create an environment to run the commands in.',
        default=False,
        action=argparse.BooleanOptionalAction,
    )

    parser.add_argument(
        '--debug',
        type=bool,
        help='If true, enables DEBUG level logging.',
        default=False,
        action=argparse.BooleanOptionalAction,
    )

    args = parser.parse_args(sys.argv[1:])

    if args.debug:
        logging.basicConfig(level=logging.DEBUG)

    # Accumulate the Bash commands to execute. Note that we will shell
    # escape all the values later, regardless of whether they come
    # from user input.
    #
    # We run these commands as a Bash script so that we can source a
    # virtualenv and use it in subsequent commands.
    script: MutableSequence[Sequence[str]] = [
        ['set', '-o', 'errexit'],
    ]

    # Create an stack ExitStack because we may or may not need to
    # create a temporary directory.
    with contextlib.ExitStack() as exit_stack:
        if args.create_environment:
            script.append(['echo', '::group::setup Python environment'])
            environment = pathlib.Path(
                exit_stack.enter_context(tempfile.TemporaryDirectory())
            )
            script.append(['python3', '-m', 'venv', os.fspath(environment)])
            script.append(['source', os.fspath(environment / 'bin/activate')])
            if len(extra_packages) > 0:
                install_cmd = [
                    'pip',
                    # In case of a bug in this code, make sure we're
                    # only installing packages in a virtual
                    # environment and not harming the user's
                    # environment.
                    '--require-virtualenv',
                    'install',
                    # The pip package is almost always out-of-date, so
                    # upgrade it.
                    'pip==23.1.1',
                ]
                install_cmd.extend(extra_packages)
                script.append(install_cmd)
            script.append(['echo', '::endgroup::'])

        script.extend(commands)

        # Enocde the script into a single escaped string to send to
        # Bash.
        lines = []
        for command in script:
            lines.append(shlex.join(command))
        script_text = '\n'.join(lines)

        # The target discovery for our commands expects to run from
        # the root of the Bosco project.
        bosco_root = pathlib.Path(__file__).parent.parent.parent.parent
        logging.debug('Bosco root: %s', bosco_root)

        if logger.isEnabledFor(logging.DEBUG):
            print('::group::script', file=sys.stderr)
            logger.debug(
                'Running script:\n%s', textwrap.indent(script_text, prefix='    ')
            )
            print('::endgroup::', file=sys.stderr)

        sys.exit(subprocess.run(['bash', '-c', script_text], cwd=bosco_root).returncode)


logger = logging.getLogger(__name__)
