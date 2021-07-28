# PyTorch TestInfra

The PyTorch TestInfra project is collection of infrastructure components that are
supporting the PyTorch CI/CD system.

## Getting started

Clone the repository:

```shell
$ git clone --recursive https://github.com/pytorch/test-infra
```

## Directories

```
├── aws                                  # Infra running in AWS
│   ├── lambda
│   └── websites                         # Several websites supported by TestInfra
│       ├── auth.pytorch.org
│       └── metrics.pytorch.org
├── stats                                # CI related stats commited automatically by a bot
└── tools                                # Tools and scripts
    ├── clang-tidy-checks
    └── scripts
```

## Linting

We use [`actionlint`](https://github.com/rhysd/actionlint) to verify that the GitHub Actions workflows in [`.github/workflows`](github/workflows) are correct. To run it locally:

1. [Set up Go](https://golang.org/doc/install)
2. Install actionlint

    ```bash
    go install github.com/rhysd/actionlint/cmd/actionlint@7040327ca40aefd92888871131adc30c7d9c1b6d
    ```
3. Run actionlint

    ```bash
    # The executable will be in ~/go/bin, so make sure that's on your PATH
    # actionlint automatically detects and uses shellcheck, so if it's not in
    # your PATH you will get different results than in CI
    actionlint
    ```

## Join the PyTorch TestInfra community
See the [`CONTRIBUTING`](CONTRIBUTING.md) file for how to help out.

## License
PyTorch TestInfra is BSD licensed, as found in the [`LICENSE`](LICENSE) file.
