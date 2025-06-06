all: run-local

clean:
	rm -rf deployment
	rm -rf venv
	rm -rf deployment.zip

venv/bin/python:
	virtualenv venv
	venv/bin/pip install -r requirements.txt

deployment.zip:
	mkdir -p deployment
	cp lambda_function.py ./deployment/.
	pip3.10 install -r requirements.txt -t ./deployment/. --platform manylinux2014_x86_64 --only-binary=:all: --implementation cp --python-version 3.10 --upgrade
	cd ./deployment && zip -q -r ../deployment.zip .

.PHONY: create-deployment-package
create-deployment-package: deployment.zip
