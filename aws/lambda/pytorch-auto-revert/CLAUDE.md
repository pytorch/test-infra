This is the autorevert lambda, its code sits here (aws/lambda/pytorch-auto-revert)

From the root of this repo (../../..) you can also find:

* `../pytorch-gha-infra/runners/regions/us-east-1/lambdas/pytorch-auto-revert.tf` where it is configured and installed
* `../pytorch/.github/workflows` the workflows it targets to

from Makefile, you can see how to setup it and run it.

You can run it with --help to understand how to run it: `venv/bin/python -m pytorch_auto_revert --help`

the hud option will allow you to run to generate and inspect past status, it generate some html

you can also check clickhouse using clickhouse-mcp to find more information and run dates

