"""
Filter for the file pathes.
"""
import pathlib

from pathspec import PathSpec


class PathFilter:
    def __call__(self, path: pathlib.Path) -> bool:
        raise NotImplementedError


class DefaultPathFilter(PathFilter):
    """
    Default BC-linter path filter (for PyTorch).
    """

    def __call__(self, file: pathlib.Path) -> bool:
        if file.suffix != '.py':
            # Only consider Python files.
            return False
        if any(dir.name.startswith('_') for dir in file.parents):
            # Ignore any internal packages.
            return False
        if any(dir.name.startswith('.') for dir in file.parents):
            # Ignore any internal packages and ci modules
            return False
        if file.name.startswith('_'):
            # Ignore internal modules.
            return False
        if any(dir.name == 'test' for dir in file.parents):
            # Ignore tests (not part of PyTorch package).
            return False
        if any(dir.name == 'benchmarks' for dir in file.parents):
            # Ignore benchmarks (not part of PyTorch package).
            return False
        if file.name.startswith('test_') or file.stem.endswith('_test'):
            # Ignore test files.
            return False

        return True


class PathSpecFilter(PathFilter):
    """
    PathSpec based path filter.

    Example:
        # include only python files
        *.py

        # exclude all files in directories starting with an underscore
        !**/_*/**

    Note:
        Matching rules are applied in order of appearance,
        i.e. the last rules take precedence over the first ones.
    """

    def __init__(self, pathspec: str):
        self.pathspec = pathspec
        self.matcher = PathSpec.from_lines('gitwildmatch', pathspec.splitlines())

    def __call__(self, path: pathlib.Path) -> bool:
        return self.matcher.match_file(path)
