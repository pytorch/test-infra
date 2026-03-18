prepare: clean
	mkdir -p ./packages
	pip3 install --target ./packages -r requirements.txt
	cd packages && zip -r ../gha-artifacts-deployment.zip .
	zip -g gha-artifacts-deployment.zip lambda_function.py

deploy: prepare
	aws lambda update-function-code --function-name gha-artifacts --zip-file fileb://gha-artifacts-deployment.zip

clean:
	rm -rf gha-artifacts-deployment.zip packages
