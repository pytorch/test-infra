prepare: clean
	mkdir -p ./packages
	pip3 install --target ./packages -r requirements.txt
	cd packages && zip -r ../clickhouse-replicator-s3-deployment.zip .
	zip -g clickhouse-replicator-s3-deployment.zip lambda_function.py

deploy: prepare
	@set -eu; \
	expected_code_sha="$$(aws lambda update-function-code \
		--function-name clickhouse-replicator-s3 \
		--zip-file fileb://clickhouse-replicator-s3-deployment.zip \
		--query CodeSha256 --output text --no-cli-pager)"; \
	aws lambda wait function-updated-v2 \
		--function-name clickhouse-replicator-s3; \
	deployed_code_sha="$$(aws lambda get-function-configuration \
		--function-name clickhouse-replicator-s3 \
		--query CodeSha256 --output text --no-cli-pager)"; \
	if [ "$$expected_code_sha" != "$$deployed_code_sha" ]; then \
		echo "deployed Lambda code hash does not match the requested update" >&2; \
		exit 1; \
	fi; \
	echo "Lambda update completed: $$deployed_code_sha"

clean:
	rm -rf clickhouse-replicator-s3-deployment.zip packages
