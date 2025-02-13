import boscoci

boscoci.main(
    commands=[
        # HACK! If we run mypy on the root before running it on the
        # tests/ directory, we fail to find pytest types. I don't
        # understand the failure, but this works around the problem.
        # Help me, please.
        ['mypy', 'src/', 'tests/'],
        ['mypy', 'scripts/'],
    ],
    extra_packages=['.', 'scripts/', 'mypy==1.2.0', 'pytest==7.3.1'],
)
