# pytorch_pkg_helpers

This is a common python utility / library for domain libraries to add common environment variables, it
is meant to replace the common packaging/pkg_helpers.bash script we have in most domain libraries.

This is primarily supposed to be used for common tooling for binary builds within domain libraries.

## Installation

```bash
pip install pytorch-pkg-helpers
```

* Requires `conda` to be installed if generate for conda packages

## Usage:

The CLI should produce a source-able env file with environment variables needed to do proper
domain library builds

```bash
python -m pytorch_pkg_helpers > env_file
source env_file
```

### Environment variables

The following environment variables change what environment variables actually get generated:

- `PACKAGE_TYPE`: (wheel, conda)
- `CHANNEl`: (nightly, test)
- `PLATFORM`: Platform to generate for (default `sys.platform`)
- `GPU_ARCH_VERSION`: GPU arch version (typically something like: [cpu, cu116, rocm5.4.1, etc.])
- `PYTHON_VERSION`: Python version to generate for
- `BASE_BUILD_VERSION` Base build version to use (will grab from root `version.txt` if not supplied)

## Developing

### Linting / Formatting:

```bash
make lint
```

### Testing:

```bash
make test
```

For verbose testing use `VERBOSE=1`

```bash
VERBOSE=1 make test
```

### Publishing new versions

Contact @seemethere to get added to the package on pypi to upload

1. Bump version in pyproject.toml
2. Run `make publish`

Eventually we should probably automate this process but it's fine to be manual for now
