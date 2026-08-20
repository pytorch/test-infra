ZIP := deployment.zip
FUNCTION := call-log-classifier

# boto3 ships in the Lambda python runtime and nothing else is imported, so the
# package is just the handler.
prepare: clean
	mkdir -p deployment
	cp lambda_function.py ./deployment/.
	cd ./deployment && zip -q -r ../$(ZIP) .

deploy: prepare
	aws lambda update-function-code --function-name $(FUNCTION) --zip-file fileb://$(ZIP)

clean:
	rm -rf deployment $(ZIP)

.PHONY: prepare deploy clean
