all: run-local

.PHONY: clean
clean:
	rm -rf deployment
	rm -rf deployment.zip
	rm -rf venv
	# it makes sense for this to be the last one, or at least after rm -rf venv
	find . -name __pycache__ -type d | xargs rm -rf

venv/bin/python:
	virtualenv venv
	venv/bin/pip install -r requirements.txt

venv/bin/lintrunner: venv/bin/python
	venv/bin/pip install lintrunner==0.12.5 boto3-stubs==1.34.51
	# lintrunner only works properly with virtualenv if you activate it first
	. venv/bin/activate && lintrunner init --config ../../../.lintrunner.toml

.PHONY: run-local
run-local: venv/bin/python
	venv/bin/python -m pytorch_auto_revert

.PHONY: run-local-workflows
run-local-workflows: venv/bin/python
	venv/bin/python -m pytorch_auto_revert autorevert-checker Lint trunk pull inductor --hours 8760 --generate-commit-data-csv --verbose

deployment.zip:
	mkdir -p deployment
	cp -a pytorch_auto_revert ./deployment/.
	cp -a __init__.py ./deployment/.
	pip3.10 install -r requirements.txt -t ./deployment/. --platform manylinux2014_x86_64 --only-binary=:all: --implementation cp --python-version 3.10 --upgrade
	cd ./deployment && zip -q -r ../deployment.zip .

.PHONY: create-deployment-package
create-deployment-package: deployment.zip

.PHONY: lintrunner
lintrunner: venv/bin/lintrunner
	# lintrunner only works properly with virtualenv if you activate it first
	. venv/bin/activate && lintrunner -a -v --force-color --config ../../../.lintrunner.toml --paths-cmd='git grep -Il .'
