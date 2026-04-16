import os
import pathlib
from typing import Optional

import api.git


def commit_file(
    git_repo: api.git.Repository,
    file: pathlib.Path,
    contents: str,
    *,
    message: Optional[str] = None,
) -> None:
    """Creates a commit with the file and contents in the repository."""
    message = message or f"setting {file} to:\n{contents}"
    file = git_repo.dir / file
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(contents)
    git_repo.run(["add", "--intent-to-add", os.fspath(file)], check=True)
    git_repo.run(["commit", f"--message={message}", os.fspath(file)], check=True)
