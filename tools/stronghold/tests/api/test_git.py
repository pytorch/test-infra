import pathlib
import re

import pytest

import api.git

from testing import git


def test_get_commit_info(git_repo: api.git.Repository) -> None:
    file = pathlib.Path('meh.txt')

    # Check-in the file initially.
    git.commit_file(git_repo, file, 'contents')
    # The diff-tree command only works if there is a second commit.
    git.commit_file(git_repo, file, 'contents\n')

    commit_info = git_repo.get_commit_info()

    assert re.fullmatch('^[0-9a-f]{40}$', commit_info.hash), commit_info.hash
    assert commit_info.files == [file]


def test_get_contents(git_repo: api.git.Repository) -> None:
    file = pathlib.Path('meh.txt')

    # Check-in the file initially.
    git.commit_file(git_repo, file, 'contents\n')

    assert git_repo.get_contents(file) == 'contents\n'


def test_get_contents_with_hash(git_repo: api.git.Repository) -> None:
    file = pathlib.Path('meh.txt')

    # Check-in the file initially.
    git.commit_file(git_repo, file, 'contents')
    # The diff-tree command only works if there is a second commit.
    git.commit_file(git_repo, file, 'contents\n')

    commit_info = git_repo.get_commit_info()

    assert git_repo.get_contents(file, commit_id=commit_info.hash) == 'contents\n'


def test_get_contents_missing_file(git_repo: api.git.Repository) -> None:
    # Check-in the file initially.
    git.commit_file(git_repo, pathlib.Path('meh.txt'), 'contents\n')

    assert git_repo.get_contents(pathlib.Path('non_existent_file.txt')) is None


def test_custom_commit_id(git_repo: api.git.Repository) -> None:
    file = pathlib.Path('meh.txt')

    # Check-in the file initially.
    git.commit_file(git_repo, file, 'contents')
    # The diff-tree command only works if there is a second commit.
    git.commit_file(git_repo, file, 'contents\n')
    # Add third commit to have multiple valid commit ids.
    git.commit_file(git_repo, file, 'new contents\n')

    # Get second commit.
    commit_info = git_repo.get_commit_info(commit_id='HEAD~')

    assert git_repo.get_contents(file, commit_id=commit_info.hash) == 'contents\n'


@pytest.fixture
def git_repo(tmp_path: pathlib.Path) -> api.git.Repository:
    """pytest fixture providing an empty initialized git repository."""
    repo = api.git.Repository(tmp_path)
    repo.run(['init'], check=True)
    # Set the user for this repository only.
    repo.run(['config', 'user.email', 'user@mcuserface.test'], check=True)
    repo.run(['config', 'user.name', 'User McUserface'], check=True)
    return repo
