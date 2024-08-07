prepare: clean
	mkdir -p ./packages
	pip3 install --target ./packages -r requirements.txt
	cd packages && zip -r ../clickhouse-replicator-dynamo-deployment.zip .
	zip -g clickhouse-replicator-dynamo-deployment.zip lambda_function.py

deploy: prepare
	aws lambda update-function-code --function-name clickhouse-replicator-dynamo --zip-file fileb://clickhouse-replicator-dynamo-deployment.zip

clean:
	rm -rf clickhouse-replicator-dynamo-deployment.zip packages
