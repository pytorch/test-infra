import pathlib

import api.config


def test_match_any_empty_patterns_matches_all() -> None:
    p = pathlib.Path("src/module/file.py")
    assert api.config.match_any(p, []) is True


def test_match_any_basic_globs() -> None:
    assert api.config.match_any(pathlib.Path("a/b/c.py"), ["**/*.py"]) is True
    assert api.config.match_any(pathlib.Path("a/b/c.txt"), ["**/*.py"]) is False
    assert api.config.match_any(pathlib.Path("a/b/c.py"), ["**/*"]) is True
    assert api.config.match_any(pathlib.Path("a/b/c.py"), ["**"]) is True
    assert api.config.match_any(pathlib.Path(".a/b/c.py"), ["**"]) is True
    # Hidden top-level dir and nested match with simplified defaults
    assert api.config.match_any(pathlib.Path(".a/b/c.py"), [".*/**"]) is True
    assert api.config.match_any(pathlib.Path(".a/b/b/c.py"), [".*/**"]) is True
    assert api.config.match_any(pathlib.Path(".a/b/b/c.py"), ["**/.*/**"]) is True
    assert api.config.match_any(pathlib.Path(".a.py"), [".*"]) is True
    assert api.config.match_any(pathlib.Path("b/.a.py"), [".*"]) is True
    assert api.config.match_any(pathlib.Path("b/.a.py"), ["**/.*"]) is True


def test_hidden_path_exclude_glob() -> None:
    # Exclude patterns are intended to filter hidden segments inside the path.
    # Note: with fnmatch semantics, '**/.*/**' does not match a leading dot
    # segment at the very start of the path (no preceding '/').
    hidden_file = pathlib.Path("pkg/.hidden/dir/file.py")
    normal_file = pathlib.Path("pkg/sub/file.py")
    exclude = [".*", ".*/**", "**/.*/**", "**/.*"]
    # Hidden path excluded
    assert api.config.match_any(hidden_file, exclude) is True
    # Normal path not excluded by hidden patterns
    assert api.config.match_any(normal_file, exclude) is False


def test_include_exclude_interaction() -> None:
    # Emulate file-level allow logic: include and not exclude
    f1 = pathlib.Path("pkg/file.py")
    f2 = pathlib.Path(".git/file.py")
    include = ["**/*.py"]
    exclude = [".*", ".*/**", "**/.*/**", "**/.*"]
    assert api.config.match_any(f1, include) and not api.config.match_any(f1, exclude)
    # With pathspec (gitwildmatch), '.*/**' excludes files under top-level hidden dirs.
    assert not (
        api.config.match_any(f2, include) and not api.config.match_any(f2, exclude)
    )


def test_top_level_benchmarks_and_tests_excluded_by_double_star_dir() -> None:
    # Verify '**/benchmarks/**' and '**/tests/**' match top-level too under pathspec
    f_bench = pathlib.Path("benchmarks/foo.py")
    f_tests = pathlib.Path("tests/foo.py")
    exclude = ["**/benchmarks/**", "**/tests/**"]
    assert api.config.match_any(f_bench, exclude) is True
    assert api.config.match_any(f_tests, exclude) is True


def test_default_exclude_minimal_sample_set() -> None:
    # Verify minimal sample set using default excludes
    cfg = api.config.default_config()
    ex = cfg.exclude
    assert (
        api.config.match_any(pathlib.Path(".a/b/b/c.py"), ex) is True
    )  # hidden dir nested
    assert (
        api.config.match_any(pathlib.Path(".a.py"), ex) is True
    )  # hidden file top-level
    assert (
        api.config.match_any(pathlib.Path("b/.a.py"), ex) is True
    )  # hidden file nested
    assert (
        api.config.match_any(pathlib.Path("b/.a.py"), ex) is True
    )  # also matched by **/.*
    assert api.config.match_any(pathlib.Path("pkg/sub/file.py"), ex) is False
