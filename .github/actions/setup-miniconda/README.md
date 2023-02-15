# setup-miniconda

Sets up miniconda in your `${RUNNER_TEMP}` environment and gives you the `${CONDA_RUN}` environment variable so you don't have to worry about polluting non-empeheral runners anymore. Intended to be used for CI, rather than binary builds (specifically it does not install `conda-build`)

## Supported platforms

- Linux-X64
- macOS-ARM64
- macOS-X64

## Usage

This action provides the following environment variables to use with the provided conda environment:

* `CONDA_RUN` to run specific commands (including python within the environment)
* `CONDA_INSTALL` to install extra dependencies within the provided environment

```yaml
      - name: Setup miniconda
        # You could potentially lock this down to a specific hash as well
        uses: pytorch/test-infra/.github/actions/setup-miniconda@main
        with:
          python_version: "3.9"
      - name: Can use ${CONDA_RUN}, outputs Python "3.9"
        run: |
          ${CONDA_RUN} python --version
          ${CONDA_RUN} python --version | grep "3.9"
      - name: Can use ${CONDA_INSTALL}, installs older numpy
        run: |
          ${CONDA_INSTALL} numpy=1.17
```
