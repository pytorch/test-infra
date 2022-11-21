import pathlib

import api.git

from testing import git


def test_get_commit_info(git_repo: api.git.Repository) -> None:
    file = pathlib.Path('meh.txt')

    # Check-in the file initially.
    git.commit_file(git_repo, file, 'contents')
    # The diff-tree command only works if there is a second commit.
    git.commit_file(git_repo, file, 'contents\n')

    commit_info = git_repo.get_commit_info()

    assert commit_info.files == [file]


def test_get_contents(git_repo: api.git.Repository) -> None:
    file = pathlib.Path('meh.txt')

    # Check-in the file initially.
    git.commit_file(git_repo, file, 'contents\n')

    assert git_repo.get_contents(file) == 'contents\n'


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

    assert git_repo.get_contents(file, commit_id='HEAD~') == 'contents\n'
