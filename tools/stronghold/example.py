"""Contains functions to test API compatibility changes."""


def removed_function() -> None:
    pass


def remove_positional_parameter(
    a: int,
    /,
    b: int,
    c: int = 0,
    *args: int,
    d: int,
    e: int = 0,
    **kwds: int,
) -> None:
    pass


def remove_flexible_parameter(
    a: int,
    /,
    b: int,
    *args: int,
    c: int,
    **kwds: int,
) -> None:
    pass


def remove_keyword_parameter(
    a: int,
    /,
    b: int,
    *args: int,
    c: int,
    **kwds: int,
) -> None:
    pass


def remove_varargs(
    a: int,
    /,
    b: int,
    *args: int,
    c: int,
    **kwds: int,
) -> None:
    pass


def remove_kwds(
    a: int,
    /,
    b: int,
    *args: int,
    c: int,
    **kwds: int,
) -> None:
    pass


def add_positional_parameter(
    a: int,
    /,
    b: int,
    c: int = 0,
    *args: int,
    d: int,
    e: int = 0,
    **kwds: int,
) -> None:
    pass


def add_positional_parameter_with_default(
    a: int,
    /,
    b: int = 0,
    c: int = 0,
    *args: int,
    d: int,
    e: int = 0,
    **kwds: int,
) -> None:
    pass


def add_flexible_parameter(
    a: int,
    /,
    b: int,
    c: int = 0,
    *args: int,
    d: int,
    e: int = 0,
    **kwds: int,
) -> None:
    pass


def add_flexible_parameter_with_default(
    a: int,
    /,
    b: int = 0,
    c: int = 0,
    *args: int,
    d: int,
    e: int = 0,
    **kwds: int,
) -> None:
    pass


def add_keyword_parameter(
    a: int,
    b: int = 0,
    /,
    c: int = 0,
    *args: int,
    d: int,
    e: int = 0,
    **kwds: int,
) -> None:
    pass


def add_keyword_parameter_with_default(
    a: int,
    b: int = 0,
    /,
    c: int = 0,
    *args: int,
    d: int,
    e: int = 0,
    **kwds: int,
) -> None:
    pass


def add_variadic_parameters(
    a: int,
    b: int = 0,
    /,
    c: int = 0,
    *,
    d: int,
    e: int = 0,
    **kwds: int,
) -> None:
    pass


def add_variadic_keywords(
    a: int,
    b: int = 0,
    /,
    c: int = 0,
    *args: int,
    d: int,
    e: int = 0,
) -> None:
    pass


def complex(
    a: int,
    /,
    b: int,
    *args: int,
    c: int,
    **kwds: int,
) -> None:
    pass
