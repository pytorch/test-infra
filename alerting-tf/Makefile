SHELL := /bin/bash

# Lambda build inputs/outputs
LAMBDA_DIR := lambda
LAMBDA_SRC := $(shell find $(LAMBDA_DIR)/src -type f -name '*.ts' 2>/dev/null)
LAMBDA_OUT := $(LAMBDA_DIR)/dist/index.js

.PHONY: build apply destroy publish logs ls-apply ls-destroy ls-publish ls-logs clean

# Incremental build: rebuild only when inputs change
$(LAMBDA_OUT): $(LAMBDA_SRC) $(LAMBDA_DIR)/package.json $(LAMBDA_DIR)/tsconfig.json
	cd $(LAMBDA_DIR) && yarn install && yarn build

build: $(LAMBDA_OUT)

apply: $(LAMBDA_OUT)
	cd infra && terraform init && terraform apply -auto-approve

destroy:
	cd infra && terraform destroy -auto-approve

publish:
	cd infra && aws sns publish --topic-arn $$(terraform output -raw sns_topic_arn) --message '{"hello":"world"}'

logs:
	cd infra && aws logs tail /aws/lambda/$$(terraform output -raw lambda_name) --follow

# LocalStack convenience targets (requires tflocal/awslocal)
ls-apply: $(LAMBDA_OUT)
	cd infra && tflocal init && tflocal apply -auto-approve

ls-destroy:
	cd infra && tflocal destroy -auto-approve

ls-publish:
	cd infra && awslocal sns publish --topic-arn $$(tflocal output -raw sns_topic_arn) --message '{"hello":"localstack"}'

ls-logs:
	cd infra && awslocal logs tail /aws/lambda/$$(tflocal output -raw lambda_name) --follow

clean:
	rm -rf $(LAMBDA_DIR)/dist infra/lambda.zip
