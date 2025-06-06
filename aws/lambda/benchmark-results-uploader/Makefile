FUNCTION_NAME=benchmark-results-uploader
PROJECT_NAME=pytorch
REGION=us-east-1

.PHONY: prepare deploy clean

prepare:
	rm -rf ./packages
	mkdir -p packages
	pip install -r requirements.txt -t packages
	cd packages && zip -r9 ../function.zip .
	zip -g function.zip lambda_function.py

deploy: prepare
	aws lambda update-function-code --function-name $(PROJECT_NAME)-$(FUNCTION_NAME) --zip-file fileb://function.zip --region $(REGION)

clean:
	rm -rf packages function.zip
