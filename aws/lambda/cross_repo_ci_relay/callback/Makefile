UTILS_SRC := $(wildcard ../utils/*.py)
PIP_FLAGS := --platform manylinux2014_x86_64 --only-binary=:all: --implementation cp --python-version 3.13
AWS_REGION := us-east-1
FUNCTION_NAME := cross_repo_ci_callback

deployment.zip: clean
	mkdir -p ./deployment/{callback,utils}
	cp *.py ./deployment/callback/ && cp $(UTILS_SRC) ./deployment/utils/
	pip3 install --target ./deployment -r ../requirements.txt $(PIP_FLAGS)
	cd deployment && zip -r ../deployment.zip .

deploy: deployment.zip
	aws lambda update-function-code --region $(AWS_REGION) --function-name $(FUNCTION_NAME) --zip-file fileb://deployment.zip

clean:
	rm -rf deployment deployment.zip

.PHONY: deploy clean
