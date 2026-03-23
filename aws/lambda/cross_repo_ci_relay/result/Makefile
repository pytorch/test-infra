SHARED := ../config.py ../utils.py ../redis_helper.py ../secrets_manager_helper.py
PIP_FLAGS := --platform manylinux2014_x86_64 --only-binary=:all: --implementation cp --python-version 3.10

clean:
	rm -rf deployment deployment.zip

deployment.zip: clean
	mkdir -p ./deployment
	cp $(SHARED) deployment/
	cp lambda_function.py result_handler.py clickhouse_client_helper.py deployment/
	pip3 install --target ./deployment -r requirements.txt $(PIP_FLAGS)
	cd deployment && zip -r ../deployment.zip .
	
.PHONY: clean deployment.zip
