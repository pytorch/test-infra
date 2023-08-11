prepare: clean
	mkdir -p ./packages
	pip install --target ./packages -r requirements.txt
	cd packages && zip -r ../opensearch-gha-jobs-deployment.zip .
	zip -g opensearch-gha-jobs-deployment.zip lambda_function.py

deploy: prepare
	aws lambda update-function-code --function-name opensearch-gha-jobs --zip-file fileb://opensearch-gha-jobs-deployment.zip

clean:
	rm -rf opensearch-gha-jobs-deployment.zip packages
