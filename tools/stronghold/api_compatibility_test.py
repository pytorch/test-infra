"""Contains functions to test API compatibility changes."""


def remove_positional_parameter(
    b: int,
    *args: int,
    c: int,
    **kwds: int,
) -> int:
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
