# Pytorch Terraform AWS Github Runner

This is a terraform module that sets up self hosted github runners on AWS along with the infra needed to autoscale them

# Release
To use the changes made to these files:
1. Merge the PR to `main` and wait for the `Create Release Tag` workflow to run (or trigger it manually). This will give your commit a unique release tag.
1. In the terraform script that consumes this module, go to the `Terrafile` file and modify the `tag` for `terraform-aws-github-runner` to point to the new release tag.

# Directories

```
├── modules
|   ├── download-lambda
|   ├── runner-binaries-syncer # AWS Lambda func that
|   ├── runners                # AWS Lambda func that scales runners up and down based
|   |                          #   on SQS Events
|   ├── runners-instances      # Defines how instances hosting new runners will be configured
|   ├── setup-iam-permissions  # See Readme in the folder
|   └── webhook                # AWS Lambda func that receives Github
|                              #   webhooks and generates SQS events that
|                              #   trigger scale up requests
├── policies
├── templates
└── terraform_migrations

```

# Runner Architecture diagram
This diagram shows how the runners function once deployed to AWS
![High level runner architecture diagram](architecture-diagram.png)
