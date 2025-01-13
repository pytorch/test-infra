prepare: clean
	mkdir -p ./packages
	pip3 install --target ./packages -r requirements.txt
	cd packages && zip -r ../whl_metadata_upload_pep658.zip .
	zip -g whl_metadata_upload_pep658.zip lambda_function.py

deploy: prepare
	aws lambda update-function-code --function-name whl_metadata_upload_pep658 --zip-file fileb://whl_metadata_upload_pep658.zip

clean:
	rm -rf whl_metadata_upload_pep658.zip packages
