import pathlib

import api.git

import pytest


@pytest.fixture
def git_repo(tmp_path: pathlib.Path) -> api.git.Repository:
    """pytest fixture providing an empty initialized git repository."""
    repo = api.git.Repository(tmp_path)
    repo.run(['init'], check=True)
    # Set the user for this repository only.
    repo.run(['config', 'user.email', 'user@mcuserface.test'], check=True)
    repo.run(['config', 'user.name', 'User McUserface'], check=True)
    return repo
