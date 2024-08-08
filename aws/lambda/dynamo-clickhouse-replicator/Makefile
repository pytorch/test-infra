prepare: clean
	mkdir -p ./packages
	pip3 install --target ./packages -r requirements.txt
	cd packages && zip -r ../dynamo-clickhouse-replicator-deployment.zip .
	zip -g dynamo-clickhouse-replicator-deployment.zip lambda_function.py

deploy: prepare
	aws lambda update-function-code --function-name dynamo-clickhouse-replicator --zip-file fileb://dynamo-clickhouse-replicator-deployment.zip

clean:
	rm -rf dynamo-clickhouse-replicator-deployment.zip packages
