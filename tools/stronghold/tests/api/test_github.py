import pathlib

import api.compatibility
import api.github


def test_render_violation() -> None:
    assert (
        api.github.render_violation(
            pathlib.Path('test.py'),
            api.compatibility.Violation(
                func='foo',
                message='**kwargs was removed',
                line=3,
            ),
        )
        == '::warning file=test.py,line=3::Function foo: **kwargs was removed'
    )
