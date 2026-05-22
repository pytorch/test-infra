AWS_REGION ?= us-east-1
CALLBACK_FUNCTION_NAME ?= cross_repo_ci_callback
WEBHOOK_FUNCTION_NAME  ?= cross_repo_ci_webhook

.PHONY: test deploy deploy-callback deploy-webhook clean

test:
	python3 -m pytest tests -v

# Deploy both; keep going on failure so a broken half doesn't block the other.
deploy:
	@rc=0; \
	for t in deploy-callback deploy-webhook; do $(MAKE) $$t || rc=$$?; done; \
	exit $$rc

deploy-callback:
	$(MAKE) -C callback deploy AWS_REGION=$(AWS_REGION) FUNCTION_NAME=$(CALLBACK_FUNCTION_NAME)

deploy-webhook:
	$(MAKE) -C webhook deploy AWS_REGION=$(AWS_REGION) FUNCTION_NAME=$(WEBHOOK_FUNCTION_NAME)

clean:
	$(MAKE) -C callback clean
	$(MAKE) -C webhook clean
