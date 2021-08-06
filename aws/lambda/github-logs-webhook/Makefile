deployment:
	# pip install --target ./python -r requirements.txt
	cd python && zip -r ../deployment.zip .
	zip -g deployment.zip lambda_function.py

manual_update: deployment
    aws lambda update-function-code --function-name github-logs-webhook --zip-file fileb://deployment.zip

clean:
	rm -rf deployment.zip python
