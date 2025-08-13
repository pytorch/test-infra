import pathlib
import textwrap
from typing import Any, List

import api.compatibility
import api.violations
import pytest
from testing import git, source


def test_deleted_function(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    after = source.make_file(tmp_path, lambda: None)

    assert api.compatibility.check(before, after) == [
        api.violations.FunctionDeleted(func="func", line=1)
    ]


def test_renamed_function(tmp_path: pathlib.Path) -> None:
    """Tests that a renamed function is just flagged as a deleted function."""

    def rose(a: int, /, b: int = 2, *args: int, c: int, **kwargs: int) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, rose)

    def rose_by_any_other_name(
        a: int, /, b: int = 2, *args: int, c: int, **kwargs: int
    ) -> None:
        pass  # pragma: no cover

    after = source.make_file(tmp_path, rose_by_any_other_name)

    assert api.compatibility.check(before, after) == [
        api.violations.FunctionDeleted(func="rose", line=1)
    ]


def test_deleted_method(tmp_path: pathlib.Path) -> None:
    class Class:
        def func(self, /) -> None:
            pass  # pragma: no cover

    before = source.make_file(tmp_path, Class)

    after = source.make_file(tmp_path, lambda: None)

    assert api.compatibility.check(before, after) == [
        api.violations.ClassDeleted(func="Class", line=1),
    ]


def test_deleted_variadic_args(tmp_path: pathlib.Path) -> None:
    def func(*args: Any) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func() -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.violations.VarArgsDeleted(func="func", line=1)
    ]


def test_deleted_variadic_kwargs(tmp_path: pathlib.Path) -> None:
    def func(**kwargs: Any) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func() -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.violations.KwArgsDeleted(func="func", line=1)
    ]


def test_unchanged_function(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    assert (
        api.compatibility.check(
            source.make_file(tmp_path, func), source.make_file(tmp_path, func)
        )
        == []
    )


def test_new_renamed_positional_parameter(tmp_path: pathlib.Path) -> None:
    def func(x: int, /) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(y: int, /) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.violations.ParameterRenamed(
            func=func.__name__, parameter="x", parameter_after="y", line=1
        )
    ]


def test_removed_positional_parameter(tmp_path: pathlib.Path) -> None:
    def func(x: int, /) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func() -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.violations.ParameterRemoved(func=func.__name__, parameter="x", line=1)
    ]


def test_removed_flexible_parameter(tmp_path: pathlib.Path) -> None:
    def func(x: int) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func() -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.violations.ParameterRemoved(func=func.__name__, parameter="x", line=1)
    ]


def test_removed_keyword_parameter(tmp_path: pathlib.Path) -> None:
    def func(*, x: int) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func() -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.violations.ParameterRemoved(func=func.__name__, parameter="x", line=1)
    ]


def test_new_required_positional_parameter(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(x: int, /) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.violations.ParameterNowRequired(func=func.__name__, parameter="x", line=1)
    ]


def test_new_required_flexible_parameter(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.violations.ParameterNowRequired(func=func.__name__, parameter="x", line=1)
    ]


def test_new_required_keyword_parameter(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(*, x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.violations.ParameterNowRequired(func=func.__name__, parameter="x", line=1)
    ]


def test_new_optional_positional_parameter(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(x: int = 0, /) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == []


def test_parameter_annotation_removed_no_violation(tmp_path: pathlib.Path) -> None:
    def func(x: int) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(x) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == []


def test_parameter_annotation_added_no_violation(tmp_path: pathlib.Path) -> None:
    def func(x) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == []


def test_deleted_inner_class_only(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before_inner_deleted.py"
    before.write_text(
        textwrap.dedent(
            """
            class Outer:
                class Inner:
                    pass
            """
        )
    )

    after = tmp_path / "after_inner_deleted.py"
    after.write_text(
        textwrap.dedent(
            """
            class Outer:
                pass
            """
        )
    )

    assert api.compatibility.check(before, after) == [
        api.violations.ClassDeleted(func="Outer.Inner", line=1)
    ]


def test_deleted_outer_class_collapses_inner_deletions(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before_outer_deleted.py"
    before.write_text(
        textwrap.dedent(
            """
            class Outer:
                class Inner:
                    pass
            """
        )
    )

    after = tmp_path / "after_outer_deleted.py"
    after.write_text("")

    violations = api.compatibility.check(before, after)
    deleted = sorted(
        v.func for v in violations if isinstance(v, api.violations.ClassDeleted)
    )
    assert deleted == ["Outer"]


def test_method_removed_only_no_class_deleted(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before_method_removed.py"
    before.write_text(
        textwrap.dedent(
            """
            class Class:
                def m(self):
                    pass
            """
        )
    )

    after = tmp_path / "after_method_removed.py"
    after.write_text(
        textwrap.dedent(
            """
            class Class:
                pass
            """
        )
    )

    # Class remains; method deletion should be reported as FunctionDeleted
    assert api.compatibility.check(before, after) == [
        api.violations.FunctionDeleted(func="Class.m", line=1)
    ]


def test_class_renamed_emits_class_deleted(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before_class_renamed.py"
    before.write_text(
        textwrap.dedent(
            """
            class Class:
                a = 1
            """
        )
    )

    after = tmp_path / "after_class_renamed.py"
    after.write_text(
        textwrap.dedent(
            """
            class Renamed:
                a = 1
            """
        )
    )

    assert api.compatibility.check(before, after) == [
        api.violations.ClassDeleted(func="Class", line=1)
    ]


def test_dataclass_field_default_change_no_violation(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before_dc_default.py"
    before.write_text(
        textwrap.dedent(
            """
            import dataclasses
            @dataclasses.dataclass
            class Class:
                a: int = 1
            """
        )
    )

    after = tmp_path / "after_dc_default.py"
    after.write_text(
        textwrap.dedent(
            """
            import dataclasses
            @dataclasses.dataclass
            class Class:
                a: int = 2
            """
        )
    )

    assert api.compatibility.check(before, after) == []


def test_class_field_order_reordered_no_violation(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before_field_order.py"
    before.write_text(
        textwrap.dedent(
            """
            class Class:
                a = 1
                b = 2
            """
        )
    )

    after = tmp_path / "after_field_order.py"
    after.write_text(
        textwrap.dedent(
            """
            class Class:
                b = 2
                a = 1
            """
        )
    )

    assert api.compatibility.check(before, after) == []


def test_nested_private_class_deleted_no_violation(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before_nested_private_cls.py"
    before.write_text(
        textwrap.dedent(
            """
            class Outer:
                class _Inner:
                    pass
            """
        )
    )

    after = tmp_path / "after_nested_private_cls.py"
    after.write_text(
        textwrap.dedent(
            """
            class Outer:
                pass
            """
        )
    )

    assert api.compatibility.check(before, after) == []


def test_dataclass_required_to_optional_field_no_violation(
    tmp_path: pathlib.Path,
) -> None:
    before = tmp_path / "before_dc_required_optional.py"
    before.write_text(
        textwrap.dedent(
            """
            import dataclasses
            @dataclasses.dataclass
            class Class:
                a: int
            """
        )
    )

    after = tmp_path / "after_dc_required_optional.py"
    after.write_text(
        textwrap.dedent(
            """
            import dataclasses
            @dataclasses.dataclass
            class Class:
                a: int = 1
            """
        )
    )

    assert api.compatibility.check(before, after) == []


def test_new_optional_flexible_parameter(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(x: int = 0) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == []


def test_new_optional_keyword_parameter(tmp_path: pathlib.Path) -> None:
    def func() -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(*, x: int = 0) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == []


def test_positional_parameter_becomes_required(tmp_path: pathlib.Path) -> None:
    def func(x: int = 0, /) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(x: int, /) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.violations.ParameterBecameRequired(
            func=func.__name__, parameter="x", line=1
        )
    ]


def test_flexible_parameter_becomes_required(tmp_path: pathlib.Path) -> None:
    def func(x: int = 0) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.violations.ParameterBecameRequired(
            func=func.__name__, parameter="x", line=1
        )
    ]


def test_keyword_parameter_becomes_required(tmp_path: pathlib.Path) -> None:
    def func(*, x: int = 0) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(*, x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.violations.ParameterBecameRequired(
            func=func.__name__, parameter="x", line=1
        )
    ]


def test_positional_parameters_reordered(tmp_path: pathlib.Path) -> None:
    def func(x: int, y: int, /) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(y: int, x: int, /) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.violations.ParameterReordered(func=func.__name__, line=1)
    ]


def test_flexible_parameters_reordered(tmp_path: pathlib.Path) -> None:
    def func(x: int, y: int) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(y: int, x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.violations.ParameterReordered(func=func.__name__, line=1)
    ]


def test_keyword_parameters_reordered(tmp_path: pathlib.Path) -> None:
    def func(*, x: int, y: int) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(*, y: int, x: int) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == []


def test_ignores_internal_func(tmp_path: pathlib.Path) -> None:
    def _func() -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, _func)
    after = source.make_file(tmp_path, lambda: None)

    # _func was deleted but it's not a violation because it's
    # internal.
    assert api.compatibility.check(before, after) == []


def test_ignores_internal_class(tmp_path: pathlib.Path) -> None:
    class _Class:
        def func(self, /) -> None:
            pass  # pragma: no cover

    before = source.make_file(tmp_path, _Class)
    after = source.make_file(tmp_path, lambda: None)

    # _Class was deleted but it's not a violation because it's
    # internal.
    assert api.compatibility.check(before, after) == []


def test_multiple_params(tmp_path: pathlib.Path) -> None:
    def func(
        b: int,
        c: int,
        /,
        d: int,
        e: int,
        *args: int,
        f: int,
        **kwds: int,
    ) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(  # type: ignore[no-redef]
        a: int,
        b: int,
        c: int,
        /,
        d: int,
        e: int,
        *args: int,
        f: int,
        **kwds: int,
    ) -> None:
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.violations.ParameterNowRequired(func=func.__name__, parameter="a", line=2)
    ]


def test_parameter_type_change_positional(tmp_path: pathlib.Path) -> None:
    def func(a: int, b: int, /) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(a: str, b: int, /) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.violations.ParameterTypeChanged(
            func=func.__name__,
            parameter="a",
            line=1,
            type_before="int",
            type_after="str",
        )
    ]


def test_parameter_type_change_named(tmp_path: pathlib.Path) -> None:
    def func(*, a: int, b: int) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(*, b: int, a: str) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == [
        api.violations.ParameterTypeChanged(
            func=func.__name__,
            parameter="a",
            line=1,
            type_before="int",
            type_after="str",
        )
    ]


def test_no_parameter_type_change_generic(tmp_path: pathlib.Path) -> None:
    def func(*, a: List[int], b: List[int]) -> None:
        pass  # pragma: no cover

    before = source.make_file(tmp_path, func)

    def func(*, b: List[int], a: List[int]) -> None:  # type: ignore[no-redef]
        pass  # pragma: no cover

    after = source.make_file(tmp_path, func)

    assert api.compatibility.check(before, after) == []


@pytest.mark.parametrize(
    "path",
    [
        "python.cpp",
        "_internal/module.py",
        "_module.py",
        "test/module.py",
        "test_module.py",
        "module_test.py",
    ],
)
def test_check_range_skips(path: str, git_repo: api.git.Repository) -> None:
    git.commit_file(
        git_repo,
        pathlib.Path(path),
        textwrap.dedent(
            """
            def will_be_deleted():
              pass
            """
        ),
    )
    git.commit_file(git_repo, pathlib.Path(path), "")
    violations = api.compatibility.check_range(git_repo, head="HEAD", base="HEAD~")
    assert violations == {}


def test_check_range(git_repo: api.git.Repository) -> None:
    git.commit_file(
        git_repo,
        pathlib.Path("module.py"),
        textwrap.dedent(
            """
            def will_be_deleted():
              pass
            """
        ),
    )
    git.commit_file(git_repo, pathlib.Path("module.py"), "")

    violations = api.compatibility.check_range(git_repo, head="HEAD", base="HEAD~")

    assert violations == {
        pathlib.Path("module.py"): [
            api.violations.FunctionDeleted(func="will_be_deleted", line=1)
        ],
    }


def test_class_field_removed(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before_cls.py"
    before.write_text(
        textwrap.dedent(
            """
            class Class:
                a = 1
                b = 2
            """
        )
    )

    after = tmp_path / "after_cls.py"
    after.write_text(
        textwrap.dedent(
            """
            class Class:
                a = 1
            """
        )
    )

    assert api.compatibility.check(before, after) == [
        api.violations.FieldRemoved(func="Class", parameter="b", line=2)
    ]


def test_dataclass_field_removed(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before.py"
    before.write_text(
        textwrap.dedent(
            """
            @dataclasses.dataclass
            class Class:
                a: int
                b: int
            """
        )
    )

    after = tmp_path / "after.py"
    after.write_text(
        textwrap.dedent(
            """
            @dataclasses.dataclass
            class Class:
                a: int
            """
        )
    )

    assert api.compatibility.check(before, after) == [
        api.violations.FieldRemoved(func="Class", parameter="b", line=3)
    ]


def test_dataclass_field_type_changed(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before_type.py"
    before.write_text(
        textwrap.dedent(
            """
            @dataclasses.dataclass
            class Class:
                a: int
            """
        )
    )

    after = tmp_path / "after_type.py"
    after.write_text(
        textwrap.dedent(
            """
            @dataclasses.dataclass
            class Class:
                a: str
            """
        )
    )

    assert api.compatibility.check(before, after) == [
        api.violations.FieldTypeChanged(
            func="Class",
            parameter="a",
            line=4,
            type_before="int",
            type_after="str",
        )
    ]


def test_class_field_added(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before_cls_add.py"
    before.write_text(
        textwrap.dedent(
            """
            class Class:
                a = 1
            """
        )
    )

    after = tmp_path / "after_cls_add.py"
    after.write_text(
        textwrap.dedent(
            """
            class Class:
                a = 1
                b = 2
            """
        )
    )

    # Adding a field to a regular class is not a BC violation
    assert api.compatibility.check(before, after) == []


def test_dataclass_field_added(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before_dc_add.py"
    before.write_text(
        textwrap.dedent(
            """
            @dataclasses.dataclass
            class Class:
                a: int
            """
        )
    )

    after = tmp_path / "after_dc_add.py"
    after.write_text(
        textwrap.dedent(
            """
            @dataclasses.dataclass
            class Class:
                a: int
                b: int
            """
        )
    )

    assert api.compatibility.check(before, after) == [
        api.violations.FieldAdded(func="Class", parameter="b", line=5)
    ]


def test_dataclass_field_added_with_default_no_violation(
    tmp_path: pathlib.Path,
) -> None:
    before = tmp_path / "before_dc_add_default.py"
    before.write_text(
        textwrap.dedent(
            """
            @dataclasses.dataclass
            class Class:
                a: int
            """
        )
    )

    after = tmp_path / "after_dc_add_default.py"
    after.write_text(
        textwrap.dedent(
            """
            @dataclasses.dataclass
            class Class:
                a: int
                b: int = 0
            """
        )
    )

    assert api.compatibility.check(before, after) == []


def test_dataclass_field_added_with_default_factory_no_violation(
    tmp_path: pathlib.Path,
) -> None:
    before = tmp_path / "before_dc_add_factory.py"
    before.write_text(
        textwrap.dedent(
            """
            import dataclasses
            @dataclasses.dataclass
            class Class:
                a: int
            """
        )
    )

    after = tmp_path / "after_dc_add_factory.py"
    after.write_text(
        textwrap.dedent(
            """
            import dataclasses
            @dataclasses.dataclass
            class Class:
                a: int
                b: list[int] = dataclasses.field(default_factory=list)
            """
        )
    )

    assert api.compatibility.check(before, after) == []


def test_dataclass_field_added_init_false_no_violation(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before_dc_add_init_false.py"
    before.write_text(
        textwrap.dedent(
            """
            import dataclasses
            @dataclasses.dataclass
            class Class:
                a: int
            """
        )
    )

    after = tmp_path / "after_dc_add_init_false.py"
    after.write_text(
        textwrap.dedent(
            """
            import dataclasses
            @dataclasses.dataclass
            class Class:
                a: int
                b: int = dataclasses.field(init=False, default=0)
            """
        )
    )

    assert api.compatibility.check(before, after) == []


def test_class_deleted_violation(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before_class_deleted.py"
    before.write_text(
        textwrap.dedent(
            """
            class Class:
                a = 1
            """
        )
    )

    after = tmp_path / "after_class_deleted.py"
    after.write_text("")

    assert api.compatibility.check(before, after) == [
        api.violations.ClassDeleted(func="Class", line=1)
    ]


def test_private_class_field_changes_no_violation(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before_private_cls.py"
    before.write_text(
        textwrap.dedent(
            """
            class Class:
                _a = 1
            """
        )
    )

    after = tmp_path / "after_private_cls.py"
    after.write_text(
        textwrap.dedent(
            """
            class Class:
                _a = 2
            """
        )
    )

    assert api.compatibility.check(before, after) == []


def test_private_dataclass_field_changes_no_violation(tmp_path: pathlib.Path) -> None:
    before = tmp_path / "before_private_dc.py"
    before.write_text(
        textwrap.dedent(
            """
            @dataclasses.dataclass
            class Class:
                _a: int
            """
        )
    )

    after = tmp_path / "after_private_dc.py"
    after.write_text(
        textwrap.dedent(
            """
            @dataclasses.dataclass
            class Class:
                _a: str
            """
        )
    )

    assert api.compatibility.check(before, after) == []
