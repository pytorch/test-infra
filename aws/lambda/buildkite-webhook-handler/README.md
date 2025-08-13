# Buildkite Webhook Handler Lambda

This Lambda function receives and processes Buildkite webhook events for build and job events, saving them to DynamoDB tables.

## Overview

The lambda handles two types of Buildkite webhook events:
- **Agent events** (`agent.*`) - Saved to `vllm-buildkite-agent-events` table
- **Build events** (`build.*`) - Saved to `vllm-buildkite-build-events` table
- **Job events** (`job.*`) - Saved to `vllm-buildkite-job-events` table

## DynamoDB Schema

### Agent Events Table: `vllm-buildkite-agent-events`
- **Partition Key**: `dynamoKey` (format: `AGENT_ID`)
- https://buildkite.com/docs/apis/webhooks/pipelines/agent-events

### Build Events Table: `vllm-buildkite-build-events`
- **Partition Key**: `dynamoKey` (format: `REPO_NAME/BUILD_NUMBER`)
- https://buildkite.com/docs/apis/webhooks/pipelines/build-events

### Job Events Table: `vllm-buildkite-job-events`
- **Partition Key**: `dynamoKey` (format: `REPO_NAME/JOB_ID`)
- https://buildkite.com/docs/apis/webhooks/pipelines/job-events

## Deployment

```bash
make create-deployment-package
```

This creates a `deployment.zip` file ready for AWS Lambda deployment.

## Event Processing

The lambda automatically:
1. Identifies event type from webhook payload
2. Extracts repository name and relevant IDs
3. Saves to appropriate DynamoDB table with structured key
4. Returns success/error response

## Error Handling

- Invalid JSON payloads return 400 status
- Missing required fields return 400 status
- DynamoDB errors return 500 status
- Unsupported event types return 400 status
