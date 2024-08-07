prepare: clean
	mkdir -p ./packages
	pip3 install --target ./packages -r requirements.txt
	cd packages && zip -r ../clickhouse-replicator-s3-deployment.zip .
	zip -g clickhouse-replicator-s3-deployment.zip lambda_function.py

deploy: prepare
	aws lambda update-function-code --function-name clickhouse-replicator-s3 --zip-file fileb://clickhouse-replicator-s3-deployment.zip

clean:
	rm -rf clickhouse-replicator-s3-deployment.zip packages
