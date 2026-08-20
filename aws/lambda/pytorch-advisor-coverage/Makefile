all: test

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
	venv/bin/pip install -r dev_requirements.txt

deployment.zip:
	mkdir -p deployment
	cp -a advisor_coverage ./deployment/.
	# Vendor only the self-contained pytorch_auto_revert helpers still imported
	# at runtime (client factories, dispatch primitive, RetryWithBackoff,
	# parse_datetime). These three modules have no intra-package imports, so we
	# copy just them (+ the package __init__) rather than the whole CLI. Copied
	# fresh at build time so the vendored source stays pristine.
	mkdir -p ./deployment/pytorch_auto_revert
	cp -a ../pytorch-auto-revert/pytorch_auto_revert/__init__.py ./deployment/pytorch_auto_revert/.
	cp -a ../pytorch-auto-revert/pytorch_auto_revert/utils.py ./deployment/pytorch_auto_revert/.
	cp -a ../pytorch-auto-revert/pytorch_auto_revert/clickhouse_client_helper.py ./deployment/pytorch_auto_revert/.
	cp -a ../pytorch-auto-revert/pytorch_auto_revert/github_client_helper.py ./deployment/pytorch_auto_revert/.
	cp -a __init__.py ./deployment/.
	pip3.10 install -r requirements.txt -t ./deployment/. --platform manylinux2014_x86_64 --only-binary=:all: --implementation cp --python-version 3.10 --upgrade
	cd ./deployment && zip -q -r ../deployment.zip .

.PHONY: create-deployment-package
create-deployment-package: deployment.zip

.PHONY: test
test: venv/bin/python
	venv/bin/python -m pytest advisor_coverage/tests -v

.PHONY: lintrunner
lintrunner: venv/bin/python
	# lintrunner only works properly with virtualenv if you activate it first
	. venv/bin/activate && lintrunner init --config ../../../.lintrunner.toml
	. venv/bin/activate && lintrunner -a -v --force-color --config ../../../.lintrunner.toml --paths-cmd='git grep -Il .'
