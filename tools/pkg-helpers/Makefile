ifdef VERBOSE
	PYTEST_VERBOSE_FLAG := -v
endif

.PHONY: lint
lint:
	poetry run black .

.PHONY: test
test:
	poetry run pytest $(PYTEST_VERBOSE_FLAG) .

.PHONY: install
install:
	poetry install
