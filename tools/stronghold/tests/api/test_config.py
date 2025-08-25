import pathlib
import textwrap

import api.compatibility
from api.config import AnnotationSpec, Config
from testing import git, source


def test_public_only_false_includes_private(tmp_path: pathlib.Path) -> None:
    class _C:
        def m(self):
            pass

    before = source.make_file(tmp_path, _C)

    after_src = textwrap.dedent(
        """
        class _C:
            pass
        """
    )
    after = tmp_path / "after.py"
    after.write_text(after_src)

    # Default public_only=True should ignore private class
    assert api.compatibility.check(before, after) == []

    # Now configure public_only=False to include it
    cfg = Config()
    cfg.scan.public_only = False
    out = api.compatibility.check(before, after, config=cfg)
    assert [type(v).__name__ for v in out] == ["FunctionDeleted"]


def test_excluded_violations_suppresses(tmp_path: pathlib.Path) -> None:
    def f(x: int):
        pass

    before = source.make_file(tmp_path, f)

    def f(x: str):  # type: ignore[no-redef]
        pass

    after = source.make_file(tmp_path, f)

    # Without suppression, we should report ParameterTypeChanged
    out = api.compatibility.check(before, after)
    assert any(v.__class__.__name__ == "ParameterTypeChanged" for v in out)

    # Suppress via excluded_violations
    cfg = Config()
    cfg.excluded_violations = ["ParameterTypeChanged"]
    out2 = api.compatibility.check(before, after, config=cfg)
    assert out2 == []


def test_annotations_exclude_suppresses_class(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before.py"
    before.write_text(
        textwrap.dedent(
            """
            import dataclasses
            @dataclasses.dataclass
            class C:
                a: int
            """
        )
    )

    after = tmp_path / "after.py"
    after.write_text(
        textwrap.dedent(
            """
            import dataclasses
            @dataclasses.dataclass
            @bc_linter_skip
            class C:
                a: int
                b: int
            """
        )
    )

    # With exclude annotation configured, FieldAdded should be suppressed
    cfg = Config()
    cfg.annotations_exclude = [
        AnnotationSpec(name="bc_linter_skip", propagate_to_members=True)
    ]
    out = api.compatibility.check(before, after, file_path=after, config=cfg)
    assert out == []


def test_annotations_include_overrides_path(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "sub" / "before.py"
    before.parent.mkdir(parents=True, exist_ok=True)
    before.write_text(
        textwrap.dedent(
            """
            import dataclasses
            @dataclasses.dataclass
            class C:
                a: int
            """
        )
    )

    after = tmp_path / "sub" / "after.py"
    after.write_text(
        textwrap.dedent(
            """
            import dataclasses
            @dataclasses.dataclass
            @bc_linter_include
            class C:
                a: int
                b: int
            """
        )
    )

    # Configure includes to a different tree so this file is not allowed by path,
    # but the include annotation should still include the symbol.
    cfg = Config()
    cfg.include = ["elsewhere/**/*.py"]
    cfg.exclude = ["**/.*/**", "**/.*"]
    cfg.annotations_include = [
        AnnotationSpec(name="bc_linter_include", propagate_to_members=True)
    ]
    out = api.compatibility.check(before, after, file_path=after, config=cfg)
    assert [type(v).__name__ for v in out] == ["FieldAdded"]


def test_check_range_respects_path_filters(git_repo) -> None:
    # Create two files changed across a commit range: one in hidden dir, one normal.
    before_hidden = textwrap.dedent(
        """
        def f(x):
            pass
        """
    )
    after_hidden = textwrap.dedent(
        """
        def f():
            pass
        """
    )
    before_norm = textwrap.dedent(
        """
        def g():
            pass
        """
    )
    after_norm = textwrap.dedent(
        """
        def g(y):
            pass
        """
    )

    # Initial commit
    git.commit_file(git_repo, pathlib.Path(".hidden/a.py"), before_hidden)
    git.commit_file(git_repo, pathlib.Path("src/b.py"), before_norm)
    base = "HEAD"

    # Change both
    git.commit_file(git_repo, pathlib.Path(".hidden/a.py"), after_hidden)
    git.commit_file(git_repo, pathlib.Path("src/b.py"), after_norm)
    head = "HEAD"

    # Default config excludes hidden paths; only src/b.py should be reported
    cfg = Config()  # defaults include hidden excludes
    out = api.compatibility.check_range(
        git_repo, head=head, base=f"{base}~", config=cfg
    )
    keys = {p.as_posix() for p in out.keys()}
    assert keys == {"src/b.py"}
    assert [type(v).__name__ for v in out[pathlib.Path("src/b.py")]] == [
        "ParameterNowRequired"
    ]


def test_disable_class_deleted_reports_method_deletions(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before_class_del.py"
    before.write_text(
        textwrap.dedent(
            """
            class C:
                def m(self):
                    pass
            """
        )
    )

    after = tmp_path / "after_class_del.py"
    after.write_text("")

    # With default config, class deletion is reported and method is suppressed
    out_default = api.compatibility.check(before, after)
    assert [type(v).__name__ for v in out_default] == ["ClassDeleted"]

    # Disable ClassDeleted; nested violations should not be emitted either
    cfg = Config()
    cfg.excluded_violations = ["ClassDeleted"]
    out = api.compatibility.check(before, after, config=cfg)
    assert out == []


def test_disable_class_deleted_reports_inner_methods(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before_inner.py"
    before.write_text(
        textwrap.dedent(
            """
            class Outer:
                class Inner:
                    def m(self):
                        pass
            """
        )
    )

    after = tmp_path / "after_inner.py"
    after.write_text(
        textwrap.dedent(
            """
            class Outer:
                pass
            """
        )
    )

    # Default: emits ClassDeleted for Outer.Inner
    out_default = api.compatibility.check(before, after)
    assert [type(v).__name__ for v in out_default] == ["ClassDeleted"]

    # Disable ClassDeleted; do not emit nested violations
    cfg = Config()
    cfg.excluded_violations = ["ClassDeleted"]
    out = api.compatibility.check(before, after, config=cfg)
    assert out == []
