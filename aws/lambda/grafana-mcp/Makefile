#!/usr/bin/make -f


# Clean build artifacts
clean:
	rm -rf deployment.zip

deployment.zip:
	@echo "Building Lambda package..."
	rm -rf deployment.zip
	
	@echo "Installing production dependencies..."
	yarn install --production
	
	@echo "Creating Lambda deployment package..."
	zip -r deployment.zip lambda_function.js package.json yarn.lock node_modules .env.example mcp.json CLAUDE.md
	
	@echo "Build complete!"

# Test Lambda function locally
test: test-env
	npm test

# Test only environment setup
test-env:
	npm run test:env

# Test only MCP integration
test-mcp:
	npm run test:mcp

# Test only Lambda simulation
test-lambda:
	npm run test:lambda

# Install test dependencies
test-deps:
	npm install

.PHONY: create-deployment-package
create-deployment-package: deployment.zip
