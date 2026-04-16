all: tflint

@PHONY: tflint
tflint: tflint-download-lambda tflint-runner-binaries-syncer tflint-runners-instances tflint-runners tflint-setup-iam-permissions tflint-webhook tflint-main

@PHONY: tflint-download-lambda
tflint-download-lambda:
	cd modules/download-lambda && \
		tofu init && \
		tflint --init && \
		tflint --call-module-type=all && \
		tofu validate

@PHONY: tflint-runner-binaries-syncer
tflint-runner-binaries-syncer:
	cd modules/runner-binaries-syncer && \
		tofu init && \
		tflint --init && \
		tflint --call-module-type=all && \
		tofu validate

@PHONY: tflint-runners-instances
tflint-runners-instances:
	cd modules/runners-instances && \
		tofu init && \
		tflint --init && \
		tflint --call-module-type=all && \
		tofu validate

@PHONY: tflint-runners
tflint-runners:
	cd modules/runners && \
		tofu init && \
		tflint --init && \
		tflint --call-module-type=all && \
		tofu validate

@PHONY: tflint-setup-iam-permissions
tflint-setup-iam-permissions:
	cd modules/setup-iam-permissions && \
		tofu init && \
		tflint --init && \
		tflint --call-module-type=all && \
		tofu validate

@PHONY: tflint-webhook
tflint-webhook:
	cd modules/webhook && \
		tofu init && \
		tflint --init && \
		tflint --call-module-type=all && \
		tofu validate

@PHONY: tflint-main
tflint-main:
	tofu init
	tflint --init
	tflint --call-module-type=all --recursive
	tofu validate

clean:
	rm -rf .terraform terraform.lock.hcl
