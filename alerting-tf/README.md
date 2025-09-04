# Minimal Alerting v1 (Terraform + TypeScript Lambda)

This folder provisions a minimal pipeline:
- SNS topic → SQS queue (+ DLQ) → Lambda (Node.js/TypeScript)
- Lambda logs each SQS record body to CloudWatch Logs, and writes the raw
  message to DynamoDB (table: "{prefix}-alerting-status").

## Prerequisites
- Terraform >= 1.6
- AWS CLI configured (SSO or profile)
- Node.js 18+ and Yarn (or npm)
- Optional: LocalStack + `tflocal`/`awslocal` for local E2E testing


## Layout
- `infra/`: Terraform for SNS, SQS, IAM, Lambda, event mapping, logs
- `lambda/`: TypeScript handler and build script
  
Additional resources
- DynamoDB table: `{prefix}-alerting-status` (stores raw SQS message bodies)

## Build the Lambda
- From `lambda/`:
  - `yarn install`
  - `yarn build` (outputs `dist/index.js`)

## Deploy (AWS)
- From `infra/`:
  - `terraform init`
  - `terraform apply -var name_prefix=alerting-dev -var aws_region=us-east-1`
- Outputs include the SNS topic ARN and SQS URL.

### Send a test message (AWS)
- First tail logs: `aws logs tail /aws/lambda/alerting-dev-alerts-handler --follow`
- Then send an SNS message: `aws sns publish --topic-arn $(terraform output -raw sns_topic_arn) --message '{"hello":"world"}'`
  
Verify DynamoDB write (AWS)
- `aws dynamodb get-item --table-name $$(terraform output -raw status_table_name) --key '{"pk":{"S":"<SQS-MessageId>"}}'`


## Local E2E (LocalStack)
Install deps for LocalStack
```
uv tool install localstack-core
uv tool install awscli-local
uv tool install terraform-local
```

- Start LocalStack (community is sufficient).
`localstack start -d` 

- Use the LocalStack Terraform/CLI wrappers to avoid editing provider config:
  - From `lambda/`: `yarn build`
  - From `infra/`: `tflocal init && tflocal apply -var name_prefix=ls -var aws_region=us-east-1`
  - Tail Logs: `awslocal logs tail /aws/lambda/ls-alerts-handler --follow`
  - Publish: `awslocal sns publish --topic-arn $(tflocal output -raw sns_topic_arn) --message '{"hello":"localstack"}'`

## Clean up
- AWS: `terraform destroy`
- LocalStack: `tflocal destroy`

Notes
- Ensure you rebuild the Lambda (`yarn build`) before each `terraform apply` if handler code changes.
- For shared environments, switch to S3 state + DynamoDB lock before multi-user use.

## Environments (dev/prod)
This repo supports two isolated AWS environments in different regions using
Terraform workspaces and per-env tfvars files.

- Dev (us-west-2): `infra/dev.us-west-2.tfvars` with `name_prefix=alerting-dev`.
- Prod (us-east-1): `infra/prod.us-east-1.tfvars` with `name_prefix=alerting-prod`.

Makefile shortcuts
- Build: `make build`
- Init backend (dev/prod): `make aws-init-dev` / `make aws-init-prod`
- Deploy dev: `make aws-apply-dev`
- Deploy prod: `make aws-apply-prod`
- Publish test (dev): `make aws-publish-dev`
- Publish test (prod): `make aws-publish-prod`
- Tail logs (dev): `make aws-logs-dev`
- Tail logs (prod): `make aws-logs-prod`

Behind the scenes, each target selects a Terraform workspace (`dev`/`prod`) and
uses a dedicated TF data dir to keep backend inits separate (`infra/.terraform-dev`
and `infra/.terraform-prod`). State is isolated per env via distinct S3 keys and
separate DynamoDB lock tables. Resource names are prefixed via `name_prefix`.

### Remote state (recommended for dev/prod)
We configure per-env backends explicitly
using `infra/backend-dev.hcl` and `infra/backend-prod.hcl`.


Manual backend.hcl examples:

backend.dev.hcl
```
bucket         = "<your-dev-tfstate-bucket>"
key            = "alerting/dev/terraform.tfstate"
region         = "us-west-2"
dynamodb_table = "<your-dev-tflock-table>"
encrypt        = true
```

backend.prod.hcl
```
bucket         = "<your-prod-tfstate-bucket>"
key            = "alerting/prod/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "<your-prod-tflock-table>"
encrypt        = true
```

Usage:
- Dev: `cd infra && terraform init -reconfigure -backend-config=../backend.dev.hcl`
- Prod: `cd infra && terraform init -reconfigure -backend-config=../backend.prod.hcl`

You can continue using the same `make aws-apply-*` targets after initializing the
backend for each environment.
