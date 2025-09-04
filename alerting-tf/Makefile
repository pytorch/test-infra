SHELL := /bin/bash

# Lambda build inputs/outputs
LAMBDA_DIR := lambda
LAMBDA_SRC := $(shell find $(LAMBDA_DIR)/src -type f -name '*.ts' 2>/dev/null)
LAMBDA_OUT := $(LAMBDA_DIR)/dist/index.js

.PHONY: build clean \
        apply aws-init-dev aws-init-prod \
        aws-apply-dev aws-apply-prod ls-apply \
        destroy aws-destroy-dev aws-destroy-prod ls-destroy \
        publish aws-publish-dev aws-publish-prod ls-publish \
        logs aws-logs-dev aws-logs-prod ls-logs

# Build: Incremental build: rebuild only when inputs change
$(LAMBDA_OUT): $(LAMBDA_SRC) $(LAMBDA_DIR)/package.json $(LAMBDA_DIR)/tsconfig.json
	cd $(LAMBDA_DIR) && yarn install && yarn build

build: $(LAMBDA_OUT)

clean:
	rm -rf $(LAMBDA_DIR)/dist infra/lambda.zip

# Apply
aws-apply-dev: aws-init-dev $(LAMBDA_OUT)
	cd infra && terraform apply -auto-approve -var-file=dev.tfvars

aws-apply-prod: aws-init-prod $(LAMBDA_OUT)
	cd infra && terraform apply -auto-approve -var-file=prod.tfvars

ls-apply: $(LAMBDA_OUT)
	cd infra && tflocal init -backend=false && tflocal apply -auto-approve

# Explicit backend init targets (idempotent).  These should run whenever 
# you want to change the backend config.
aws-init-dev:
	cd infra && terraform init -reconfigure -backend-config=backend-dev.hcl

aws-init-prod:
	cd infra && terraform init -reconfigure -backend-config=backend-prod.hcl

# Destroy
destroy:
	cd infra && terraform destroy -auto-approve

aws-destroy-dev: aws-init-dev
	cd infra && terraform destroy -auto-approve -var-file=dev.tfvars

aws-destroy-prod: aws-init-prod
	cd infra && terraform destroy -auto-approve -var-file=prod.tfvars

ls-destroy:
	cd infra && tflocal destroy -auto-approve

# Publish
publish:
	cd infra && aws sns publish --topic-arn $$(terraform output -raw sns_topic_arn) --message '{"hello":"world"}'

aws-publish-dev: aws-init-dev
	cd infra && TOPIC=$$(terraform output -raw sns_topic_arn); aws sns publish --region us-west-2 --topic-arn $$TOPIC --message '{"hello":"dev"}'

aws-publish-prod: aws-init-prod
	cd infra && TOPIC=$$(terraform output -raw sns_topic_arn); aws sns publish --region us-east-1 --topic-arn $$TOPIC --message '{"hello":"prod"}'

ls-publish:
	cd infra && awslocal sns publish --topic-arn $$(tflocal output -raw sns_topic_arn) --message '{"hello":"localstack"}'

# Logs
logs:
	cd infra && aws logs tail /aws/lambda/$$(terraform output -raw lambda_name) --follow

aws-logs-dev: aws-init-dev
	cd infra && LAMBDA=$$(terraform output -raw lambda_name); aws logs tail --region us-west-2 /aws/lambda/$$LAMBDA --follow

aws-logs-prod: aws-init-prod
	cd infra && LAMBDA=$$(terraform output -raw lambda_name); aws logs tail --region us-east-1 /aws/lambda/$$LAMBDA --follow

ls-logs:
	cd infra && awslocal logs tail /aws/lambda/$$(tflocal output -raw lambda_name) --follow
