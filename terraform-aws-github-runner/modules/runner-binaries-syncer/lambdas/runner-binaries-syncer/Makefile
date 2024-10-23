SHELL=/bin/bash -o pipefail

.PHONY: clean
clean:
	rm -rf dist node_modules
	rm runner-binaries-syncer.zip

.PHONY: build
build:
	yarn install
	yarn lint
	yarn format-check
	NODE_OPTIONS="--openssl-legacy-provider" yarn build
	# TODO: Fix broken tests.
	# yarn test

.PHONY: dist
dist:
	yarn install
	NODE_OPTIONS="--openssl-legacy-provider" yarn dist
