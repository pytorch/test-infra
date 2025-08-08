import os

import boscoci

virtual_env = os.environ.get('VIRTUAL_ENV', None)

boscoci.main(
    commands=[
        ['flake8']
        + ([f'--exclude={virtual_env}'] if virtual_env is not None else [])
        + ['.']
    ],
    extra_packages=['flake8==6.0.0'],
)
