"""Queries a PR from the command line, testing the github API.

Example:
    $ python query_pr.py --token="$(gh auth token)" pytorch/pytorch/7777
"""

import argparse
import asyncio
import logging
import pprint
import re
import sys

import bosco.github
import bosco.model


def main() -> None:
    logging.basicConfig(level=logging.DEBUG)

    parser = argparse.ArgumentParser(
        sys.argv[0],
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        '--token',
        type=str,
        required=True,
        help='https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token',  # noqa: E501
    )
    parser.add_argument('pr', type=str)
    args = parser.parse_args(sys.argv[1:])

    match = re.fullmatch(r'(\w+)/(\w+)/(\d+)', args.pr)
    assert match is not None
    org, repo_name, pr_str = match.groups()

    repo = bosco.github.Repository(org, repo_name)
    pr_id = bosco.github.PR(repo, int(pr_str))

    client = bosco.github.Client(token=args.token)
    pr = asyncio.run(bosco.model.PR.query(client, pr_id))
    pprint.pp(pr)


if __name__ == '__main__':
    main()
