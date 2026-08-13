ZIP := github-status-test-deployment.zip
# Third-party modules lambda_function.py imports. The built zip is checked for
# these before it can be deployed: a package missing a dependency fails at
# import, which drops every event the webhook sends -- not just the log
# download -- and update-function-code publishes straight to $LATEST, which is
# what API Gateway invokes.
VENDORED := boto3 requests github

# The lambda runs on python3.9/x86_64. cryptography ships compiled wheels, so
# pin the target platform rather than inheriting whatever python the CI runner
# happens to default to -- otherwise the zip gets wheels the runtime can't load.
# Starts from clean so a stale packages/ or zip can't leak into the artifact.
prepare: clean
	mkdir -p ./packages
	pip install --target ./packages \
		--platform manylinux2014_x86_64 --python-version 3.9 \
		--implementation cp --only-binary=:all: --no-compile \
		-r requirements.txt
	cd packages && zip -r ../$(ZIP) .
	zip -g $(ZIP) lambda_function.py
	$(MAKE) verify

verify:
	@for m in $(VENDORED); do \
		unzip -l $(ZIP) | grep -qE " $$m/__init__\.py$$" \
			|| { echo "ERROR: '$$m' missing from $(ZIP), refusing to deploy"; exit 1; }; \
	done
	@echo "verified: $(ZIP) contains $(VENDORED)"

deploy: prepare
	aws lambda update-function-code --function-name github-status-test --zip-file fileb://$(ZIP)

clean:
	rm -rf $(ZIP) packages
