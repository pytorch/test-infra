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
│       ├── download.pytorch.org
│       └── metrics.pytorch.org
├── stats                                # CI related stats commited automatically by a bot
├── tools                                # Tools and scripts
|   ├── clang-tidy-checks
|   └── scripts
└── torchci                              # Code for hud.pytorch.org and our pytorch bots which run there   
    └── pages 
```

## Setting up your Dev environment to locally run hud.pytorch.org
1. Install yarn:
    E.g. for macs: `brew install yarn`
2. `cd torchci` and install dependencies with `yarn install`
2. Setup your environment variables

    a. Copy `torchci/.env.example` to `torchci/.env.local` to create a local copy of your environmnet variables. This will NOT be checked into git

    b. For every environment setting defined in there, copy over the corresponding value [from Vercel](https://vercel.com/torchci/torchci/settings/environment-variables) (this requires access to our Vercel deployment)
    
3. From `torchci` run `yarn dev` to start the dev server. The local endpoint will be printed on the console, it'll most likely be `http://localhost:3000`. You can find more useful yarn commands in `package.json` under the `scripts` section.

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
