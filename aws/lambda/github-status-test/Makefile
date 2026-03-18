prepare:
	mkdir -p ./packages
	pip install --target ./packages -r requirements.txt
	cd packages && zip -r ../github-status-test-deployment.zip .
	zip -g github-status-test-deployment.zip lambda_function.py

deploy: prepare
	aws lambda update-function-code --function-name github-status-test --zip-file fileb://github-status-test-deployment.zip

clean:
	rm -rf github-status-test-deployment.zip packages
