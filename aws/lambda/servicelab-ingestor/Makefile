prepare: clean
	mkdir -p ./packages
	pip3 install --target ./packages -r requirements.txt
	cd packages && zip -r ../servicelab-ingestor.zip .
	zip -g servicelab-ingestor.zip lambda_function.py

deploy: prepare
	aws lambda update-function-code --function-name servicelab-ingestor --zip-file fileb://servicelab-ingestor.zip

clean:
	rm -rf servicelab-ingestor.zip packages
