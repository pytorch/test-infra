import pathlib

import api.compatibility
import api.github
import api.violations

import pytest


@pytest.mark.parametrize('level', ['notice', 'warning'])
def test_render_violation(level: str) -> None:
    assert (
        api.github.render_violation(
            level,
            pathlib.Path('test.py'),
            api.violations.KwArgsDeleted(
                func='foo',
                line=3,
            ),
        )
        == f'::{level} file=test.py,line=3::Function foo: **kwargs was removed'
    )
