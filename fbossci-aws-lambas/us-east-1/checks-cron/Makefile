deployment.zip:
	pip install --target ./python -r requirements.txt
	cd python && zip -r ../deployment.zip .
	zip -g deployment.zip lambda_function.py

manual_update: deployment.zip
	aws lambda update-function-code --function-name github-checks-status-updater --zip-file fileb://deployment.zip

clean:
	rm -rf deployment.zip python