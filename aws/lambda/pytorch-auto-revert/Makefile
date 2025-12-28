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
	venv/bin/pip install -r dev_requirements.txt
	# lintrunner only works properly with virtualenv if you activate it first
	. venv/bin/activate && lintrunner init --config ../../../.lintrunner.toml

.PHONY: run-local-workflows
run-local-workflows: venv/bin/python
	NOTIFY_ISSUE_NUMBER=265 REPO_FULL_NAME=pytorch/pytorch-canary venv/bin/python -m pytorch_auto_revert --dry-run autorevert-checker Lint trunk pull inductor linux-binary-manywheel --hours 16

.PHONY: run-local-hud
run-local-hud: venv/bin/python
	NOTIFY_ISSUE_NUMBER=265 REPO_FULL_NAME=pytorch/pytorch-canary venv/bin/python -m pytorch_auto_revert --dry-run hud

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

.PHONY: test
test: venv/bin/python
	venv/bin/python -m unittest discover -vs pytorch_auto_revert/tests -p 'test_*.py'
