deployment:
	pip install --target ./python -r requirements.txt
	cd python && zip -r ../deployment.zip .
	zip -g deployment.zip lambda_function.py utils.py existing_schema.py

manual_update:
	aws lambda update-function-code --function-name github-webhook-rds-sync-app --zip-file fileb://deployment.zip

clean:
	rm -rf deployment.zip python
