import boscoci

boscoci.main(
    commands=[
        # We have to run the tests, but we aren't interested in the
        # test output, since we get that from the pytest job. Hide it
        # in a group so we see the coverage report front and center.
        ['echo', '::group::run tests'],
        ['coverage', 'run', '--module', 'pytest'],
        ['echo', '::endgroup::'],
        # We really care about the coverage report here.
        ['coverage', 'report'],
    ],
    extra_packages=['.', 'coverage[toml]==7.2.3', 'pytest==7.3.1'],
)
