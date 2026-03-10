SHARED := config.py utils.py redis_helper.py secrets_manager_helper.py
PIP_FLAGS := --platform manylinux2014_x86_64 --only-binary=:all: --implementation cp --python-version 3.10

prepare-webhook: clean-webhook
	mkdir -p ./webhook/deployment
	cp $(SHARED) webhook/deployment/
	cp webhook/lambda_function.py webhook/webhook_handler.py webhook/github_client_helper.py webhook/deployment/
	pip3 install --target ./webhook/deployment -r webhook/requirements.txt $(PIP_FLAGS)
	cd webhook/deployment && zip -r ../deployment.zip .

prepare-result: clean-result
	mkdir -p ./result/deployment
	cp $(SHARED) result/deployment/
	cp result/lambda_function.py result/result_handler.py result/clickhouse_client_helper.py result/deployment/
	pip3 install --target ./result/deployment -r result/requirements.txt $(PIP_FLAGS)
	cd result/deployment && zip -r ../deployment.zip .

prepare: prepare-webhook prepare-result

deploy-webhook: prepare-webhook
	aws lambda update-function-code --function-name cross_repo_ci_webhook --zip-file fileb://webhook/deployment.zip

deploy-result: prepare-result
	aws lambda update-function-code --function-name cross_repo_ci_result --zip-file fileb://result/deployment.zip

deploy: deploy-webhook deploy-result

clean-webhook:
	rm -rf webhook/deployment webhook/deployment.zip

clean-result:
	rm -rf result/deployment result/deployment.zip

clean: clean-webhook clean-result

.PHONY: prepare prepare-webhook prepare-result deploy deploy-webhook deploy-result clean clean-webhook clean-result
