ifdef VERBOSE
	PYTEST_VERBOSE_FLAG := -vv
endif

.PHONY: all
all: install lint test

.PHONY: lint
lint:
	poetry run ufmt format .
	poetry run flake8

.PHONY: test
test:
	poetry run pytest $(PYTEST_VERBOSE_FLAG) .

.PHONY: install
install:
	poetry install

.PHONY: publish
publish:
	poetry publish
