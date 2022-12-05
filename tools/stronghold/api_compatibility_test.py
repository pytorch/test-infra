"""Contains functions to test API compatibility changes."""


def removed_function() -> None:
    pass


def complex(
    a: int,
    /,
    *args: int,
    c: int,
    **kwds: int,
) -> None:
    pass
