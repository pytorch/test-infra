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

## Join the PyTorch TestInfra community
See the [`CONTRIBUTING`](CONTRIBUTING.md) file for how to help out.

## License
PyTorch TestInfra is BSD licensed, as found in the [`LICENSE`](LICENSE) file.
