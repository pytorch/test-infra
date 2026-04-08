SHARED := config.py utils.py redis_helper.py allowlist.py gh_helper.py event_handler.py
PIP_FLAGS := --platform manylinux2014_x86_64 --only-binary=:all: --implementation cp --python-version 3.13
AWS_REGION := us-east-1
FUNCTION_NAME := cross_repo_ci_webhook

deployment.zip: clean
	mkdir -p ./deployment
	cp $(SHARED) lambda_function.py ./deployment/
	pip3 install --target ./deployment -r requirements.txt $(PIP_FLAGS)
	cd deployment && zip -r ../deployment.zip .

deploy: deployment.zip
	aws lambda update-function-code --region $(AWS_REGION) --function-name $(FUNCTION_NAME) --zip-file fileb://deployment.zip

test:
	python3 -m pytest tests -v

clean:
	rm -rf deployment deployment.zip

.PHONY: prepare deploy test clean
