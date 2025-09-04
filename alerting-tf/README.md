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
