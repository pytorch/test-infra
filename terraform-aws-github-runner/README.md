# Pytorch Terraform AWS Github Runner

This is a terraform module that sets up self hosted github runners on AWS along with the infra needed to autoscale them

# Release
Terraform code that uses this module specify the tag (version of test-infra) that they use via a file called `Terrafile`.  We need to create a new tag for any changes here that we want to deploy and update the `Terrafile` to refer to that tag:

1. Merge any changes to this folder to `main` and wait for the `Create Release Tag` workflow to run (or trigger it manually). This will give your commit a unique release tag.
1. In the terraform script that consumes this module, go to the `Terrafile` file and modify the `tag` for `terraform-aws-github-runner` to point to the new release tag.
1. Now when you apply the terraform code that uses this module, it'll pull in your changes (for PyTorch CI, there are workflows you trigger in pytorch-gha-infra and ci-infra for this step).

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
