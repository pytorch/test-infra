import boscoci

boscoci.main(
    commands=[['mypy', '.']],
    extra_packages=['mypy==1.2.0'],
)
