import pytest
from pytorch_pkg_helpers.utils import transform_cuversion


@pytest.mark.parametrize(
    "args,expected",
    [
        ("cu116", "11.6"),
        ("cu102", "10.2"),
        ("cu92", "9.2"),
        ("cpu", "cpu"),
    ],
)
def test_transform_cuversion(args, expected):
    assert transform_cuversion(args) == expected
