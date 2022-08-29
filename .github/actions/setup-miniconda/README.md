# setup-miniconda

Sets up miniconda in your ${RUNNER_TEMP} environment and gives you the ${CONDA_RUN} environment variable so you don't have to worry about polluting non-empeheral runners anymore

## Supported platforms

- macOS-ARM64
- macOS-X64

## Usage

```yaml
      - name: Setup miniconda
        # You could potentially lock this down to a specific hash as well
        uses: pytorch/test-infra/.github/actions/setup-miniconda@main
        with:
          python_version: "3.9"
      - name: Can use ${CONDA_RUN}, outputs Python "3.9"
        run: |
          ${CONDA_RUN} python --version | grep "3.9"
```
