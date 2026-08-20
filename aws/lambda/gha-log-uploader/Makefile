ZIP := gha-log-uploader-deployment.zip
FUNCTION := gha-log-uploader
# Must match the deployed runtime. The package contains version-specific
# compiled wheels (cffi), so a package built for one python on a function
# running another fails at import on every single invocation. `deploy` checks
# this against the live function rather than trusting the two to stay in sync.
PYTHON_VERSION := 3.12
# Third-party modules lambda_function.py imports. The built zip is checked for
# these before it can be deployed: a package missing a dependency fails at
# import, which drops every log upload until someone notices.
VENDORED := boto3 requests github

# The lambda runs on x86_64. cryptography ships compiled wheels, so pin the
# target platform rather than inheriting whatever python the CI runner happens
# to default to -- otherwise the zip gets wheels the runtime can't load.
# Starts from clean so a stale packages/ or zip can't leak into the artifact.
prepare: clean
	mkdir -p ./packages
	pip install --target ./packages \
		--platform manylinux2014_x86_64 --python-version $(PYTHON_VERSION) \
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

# Refuse to publish a package built for a different python than the function
# actually runs. Without this the two can drift silently and the first symptom
# is Runtime.ImportModuleError on every invocation.
check-runtime:
	@live=$$(aws lambda get-function-configuration --function-name $(FUNCTION) \
		--query Runtime --output text); \
	if [ "$$live" != "python$(PYTHON_VERSION)" ]; then \
		echo "ERROR: $(FUNCTION) runs $$live but this package targets python$(PYTHON_VERSION)."; \
		echo "       Change the function runtime first, or set PYTHON_VERSION to $${live#python}."; \
		exit 1; \
	fi; \
	echo "runtime check: $(FUNCTION) runs $$live, package targets python$(PYTHON_VERSION)"

deploy: check-runtime prepare
	aws lambda update-function-code --function-name $(FUNCTION) --zip-file fileb://$(ZIP)

clean:
	rm -rf $(ZIP) packages
