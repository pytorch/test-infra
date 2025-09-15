SHELL := /bin/bash

# Lambdas (collector + external-alerts-webhook)
LAMBDAS_DIR := lambdas
COLLECTOR_DIR := $(LAMBDAS_DIR)/collector
WEBHOOK_DIR := $(LAMBDAS_DIR)/external-alerts-webhook
COLLECTOR_SRC := $(shell find $(COLLECTOR_DIR)/src -type f -name '*.ts' 2>/dev/null)
WEBHOOK_SRC := $(shell find $(WEBHOOK_DIR)/src -type f -name '*.ts' 2>/dev/null)
COLLECTOR_OUT := $(COLLECTOR_DIR)/dist/index.js
WEBHOOK_OUT := $(WEBHOOK_DIR)/dist/index.js

# Optional local secrets var-file (ignored by Git)
SECRETS_FILE := infra/secrets.local.tfvars
SECRETS_ARG := $(if $(wildcard $(SECRETS_FILE)),-var-file=$(notdir $(SECRETS_FILE)))

# Regions parsed from per-env tfvars (simple extractor)
DEV_TFVARS := infra/dev.tfvars
PROD_TFVARS := infra/prod.tfvars
DEV_REGION := $(shell sed -n 's/^aws_region[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' $(DEV_TFVARS))
PROD_REGION := $(shell sed -n 's/^aws_region[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' $(PROD_TFVARS))

.PHONY: build clean \
        aws-init-dev aws-init-prod \
        aws-apply-dev aws-apply-prod ls-apply \
        destroy aws-destroy-dev aws-destroy-prod ls-destroy \
        aws-publish-dev aws-publish-prod ls-publish \
        aws-logs-dev aws-logs-prod ls-logs logs-dev logs-prod

# Build: Incremental build: rebuild only when inputs change
$(COLLECTOR_OUT): $(COLLECTOR_SRC) $(COLLECTOR_DIR)/package.json $(COLLECTOR_DIR)/tsconfig.json
	cd $(COLLECTOR_DIR) && yarn install && yarn build

$(WEBHOOK_OUT): $(WEBHOOK_SRC) $(WEBHOOK_DIR)/package.json $(WEBHOOK_DIR)/tsconfig.json
	cd $(WEBHOOK_DIR) && yarn install && yarn build

build: $(COLLECTOR_OUT) $(WEBHOOK_OUT)

clean:
	rm -rf $(COLLECTOR_DIR)/dist $(WEBHOOK_DIR)/dist infra/collector.zip infra/external-alerts-webhook.zip

# Apply
aws-apply-dev: aws-init-dev build
	cd infra && terraform apply -auto-approve -var-file=dev.tfvars $(SECRETS_ARG)

aws-apply-prod: aws-init-prod build
	cd infra && terraform apply -auto-approve -var-file=prod.tfvars $(SECRETS_ARG)

ls-apply: build
	cd infra \
		&& rm -rf .terraform terraform.tfstate terraform.tfstate.backup \
		&& ( [ -f versions.remote.tf ] && mv versions.remote.tf versions.remote.tf.bak || true ) \
		&& tflocal init -backend=false -reconfigure \
		&& tflocal apply -auto-approve $(SECRETS_ARG) \
		&& ( [ -f versions.remote.tf.bak ] && mv versions.remote.tf.bak versions.remote.tf || true )

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
	cd infra && terraform destroy -auto-approve -var-file=dev.tfvars $(SECRETS_ARG)

aws-destroy-prod: aws-init-prod
	cd infra && terraform destroy -auto-approve -var-file=prod.tfvars $(SECRETS_ARG)

ls-destroy:
	cd infra \
		&& rm -rf .terraform terraform.tfstate terraform.tfstate.backup \
		&& ( [ -f versions.remote.tf ] && mv versions.remote.tf versions.remote.tf.bak || true ) \
		&& tflocal destroy -auto-approve $(SECRETS_ARG) \
		&& ( [ -f versions.remote.tf.bak ] && mv versions.remote.tf.bak versions.remote.tf || true )

# Publish
aws-publish-dev: aws-init-dev
	cd infra && TOPIC=$$(terraform output -raw sns_topic_arn); aws sns publish --region $(DEV_REGION) --topic-arn $$TOPIC --message '{"hello":"dev for github"}'

aws-publish-prod: aws-init-prod
	cd infra && TOPIC=$$(terraform output -raw sns_topic_arn); aws sns publish --region $(PROD_REGION) --topic-arn $$TOPIC --message '{"hello":"prod"}'

ls-publish:
	cd infra && awslocal sns publish --topic-arn $$(tflocal output -raw sns_topic_arn) --message '{"hello":"localstack"}'

# Logs
logs-dev: aws-logs-dev
	@true

logs-prod: aws-logs-prod
	@true

aws-logs-dev: aws-init-dev
	cd infra && LAMBDA=$$(terraform output -raw collector_name); aws logs tail --region $(DEV_REGION) /aws/lambda/$$LAMBDA --follow

aws-logs-prod: aws-init-prod
	cd infra && LAMBDA=$$(terraform output -raw collector_name); aws logs tail --region $(PROD_REGION) /aws/lambda/$$LAMBDA --follow

ls-logs:
	cd infra \
		&& ( [ -f versions.remote.tf ] && mv versions.remote.tf versions.remote.tf.bak || true ) \
		&& awslocal logs tail /aws/lambda/$$(tflocal output -raw collector_name) --follow \
		&& ( [ -f versions.remote.tf.bak ] && mv versions.remote.tf.bak versions.remote.tf || true )
