import pathlib

import pytest

import api.compatibility
import api.github


@pytest.mark.parametrize('level', ['notice', 'warning'])
def test_render_violation(level: str) -> None:
    assert (
        api.github.render_violation(
            level,
            pathlib.Path('test.py'),
            api.compatibility.Violation(
                func='foo',
                message='**kwargs was removed',
                line=3,
            ),
        )
        == f'::{level} file=test.py,line=3::Function foo: **kwargs was removed'
    )
