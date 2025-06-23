all: run-local

clean:
	rm -rf deployment
	rm -rf venv
	rm -rf deployment.zip

venv/bin/python:
	virtualenv venv

deployment.zip:
	mkdir -p deployment
	cp lambda_function.py ./deployment/.
	cd ./deployment && zip -q -r ../deployment.zip .

.PHONY: create-deployment-package
create-deployment-package: deployment.zip
