SHELL=/bin/bash -o pipefail

.PHONY: clean
clean:
	rm -rf dist node_modules coverage
	rm runners.zip

.PHONY: build
build:
	yarn install
	yarn lint
	yarn format-check
	NODE_OPTIONS="--openssl-legacy-provider" yarn build
	yarn test

.PHONY: dist
dist:
	yarn install
	NODE_OPTIONS="--openssl-legacy-provider" yarn dist
