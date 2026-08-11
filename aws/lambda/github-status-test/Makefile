# The lambda runs on python3.9/x86_64. cryptography ships compiled wheels, so
# pin the target platform rather than inheriting whatever python the CI runner
# happens to default to -- otherwise the zip gets wheels the runtime can't load.
prepare:
	mkdir -p ./packages
	pip install --target ./packages \
		--platform manylinux2014_x86_64 --python-version 3.9 \
		--implementation cp --only-binary=:all: --no-compile \
		-r requirements.txt
	cd packages && zip -r ../github-status-test-deployment.zip .
	zip -g github-status-test-deployment.zip lambda_function.py

deploy: prepare
	aws lambda update-function-code --function-name github-status-test --zip-file fileb://github-status-test-deployment.zip

clean:
	rm -rf github-status-test-deployment.zip packages
