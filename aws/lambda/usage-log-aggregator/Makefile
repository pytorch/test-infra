prepare: clean
	mkdir -p ./packages
	pip3 install --target ./packages -r requirements.txt
	cd packages && zip -r ../usage-log-aggregator.zip .
	zip -g usage-log-aggregator.zip lambda_function.py

deploy: prepare
	# NB: Don't run this manually on your MacOS laptop as this will ends up with a broken
	# numpy on AWS lambda. This needs to be run on a Linux server compatible with lambda
	# instead
	aws s3 cp usage-log-aggregator.zip s3://gha-artifacts/lambda/usage-log-aggregator.zip
	aws lambda update-function-code --function-name usage-log-aggregator --s3-bucket gha-artifacts --s3-key lambda/usage-log-aggregator.zip

clean:
	rm -rf usage-log-aggregator.zip packages
