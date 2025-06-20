all: run-local

clean:
	rm -rf deployment
	rm -rf deployment.zip
	rm -rf venv
	# it makes sense for this to be the last one, or at least after rm -rf venv
	find . -name __pycache__ -type d | xargs rm -rf

venv/bin/python:
	virtualenv venv
	venv/bin/pip install -r requirements.txt

.PHONY: run-local
run-local: venv/bin/python
	venv/bin/python pytorch_auto_revert

deployment.zip:
	mkdir -p deployment
	cp -a pytorch-auto-revert. ./deployment/.
	pip3.10 install -r requirements.txt -t ./deployment/. --platform manylinux2014_x86_64 --only-binary=:all: --implementation cp --python-version 3.10 --upgrade
	cd ./deployment && zip -q -r ../deployment.zip .

.PHONY: create-deployment-package
create-deployment-package: deployment.zip
