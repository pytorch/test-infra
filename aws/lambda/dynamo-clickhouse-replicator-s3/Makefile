prepare: clean
	mkdir -p ./packages
	pip3 install --target ./packages -r requirements.txt
	cd packages && zip -r ../dynamo-clickhouse-replicator-s3-deployment.zip .
	zip -g dynamo-clickhouse-replicator-s3-deployment.zip lambda_function.py

deploy: prepare
	aws lambda update-function-code --function-name dynamo-clickhouse-replicator-s3 --zip-file fileb://dynamo-clickhouse-replicator-s3-deployment.zip

clean:
	rm -rf dynamo-clickhouse-replicator-s3-deployment.zip packages
