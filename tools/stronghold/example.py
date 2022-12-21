"""Contains functions to test API compatibility changes."""


def parameter_added_with_lots_of_parameters(
    a: str,
    b: int,
    c: int,
    d: int,
    /,
    e: int,
    f: int,
    g: int,
    # *args and any keyword parameters will not be affected by the new
    # positional parameter.
    *args: int,
    h: int,
    i: int,
    j: int,
    **kwds: int,
) -> None:
    pass


def remove_positional_parameter(
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
) -> None:
    pass


def add_positional_parameter(
    a: int,
    new_param: int,
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
    new_param: int = 0,
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
    new_param: int,
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


def remove_positional_parameter_with_varargs(
    *args: int,
) -> None:
    pass


<<<<<<< dest:   bb298b9fcf8f - mikeyd: add functions to test API compatibilit...
=======
def remove_varargs(
) -> None:
    pass


def remove_kwargs(
) -> None:
    pass


>>>>>>> source: 6da7f9fb7ffe - mikeyd: violate API compatibility checks
def remove_keyword_parameter_with_kwargs(
    **kwds: int,
) -> None:
    pass


def remove_flexible_parameter_with_varargs_and_kwargs(
    *args: int,
    **kwds: int,
) -> None:
    pass


def rename_parameter(
    b: int,
) -> None:
    pass


def reorder_parameters(
    b: int,
    a: int,
) -> None:
    pass
