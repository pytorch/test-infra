# Grafana MCP Lambda with Fargate Architecture & Session Management

This project implements a Grafana MCP (Model Context Protocol) integration using AWS Lambda with Claude CLI and Python MCP servers, featuring persistent session management via S3.

## Architecture Overview

```
TorchCI Frontend → Next.js API → Lambda Function (Node.js + Claude CLI)
                                          ↓                  ↓
                                   MCP Servers          S3 Session Storage
                                (grafana_mcp +              ↓
                                clickhouse_mcp)      /tmp/.claude ←────┘
```

### Key Features

- **Persistent Sessions**: User sessions stored in S3 with 30-day retention
- **Claude Local Storage**: Uses `/tmp/.claude` folder for Claude's local state
- **Session Isolation**: Each user UUID gets isolated session storage
- **Automatic Cleanup**: Prevents cross-contamination between requests
- **Streaming Responses**: Real-time response streaming from Claude
- **Claude CLI Integration**: Direct integration with Claude Code CLI for MCP execution

## Session Management

### How It Works

1. **Session Restoration**: On each request, downloads user's session zip from S3 to `/tmp/.claude`
2. **Claude Context**: Claude maintains persistent context across requests using local storage
3. **Session Persistence**: After processing, uploads updated session back to S3 as zip
4. **Automatic Cleanup**: S3 lifecycle policy removes sessions after 30 days

### API Usage

```bash
POST <lambda_function_url>
Content-Type: application/json

{
  "query": "Create a dashboard showing CPU usage metrics from ClickHouse",
  "userUuid": "user-123-456-789"
}
```

**Required Parameters:**

- `query`: The user's request/question
- `userUuid`: Unique identifier for session management (recommend UUID v4)

### Response Format

The Lambda streams responses in real-time, similar to ChatGPT's interface. Each user maintains their own persistent context across sessions.

## Directory Structure

```
├── docker/
│   ├── grafana-mcp/          # Grafana FastMCP container with SSE
│   └── clickhouse-mcp/       # ClickHouse FastMCP container with SSE
├── test/                     # Unit and integration tests
├── lambda_function.js        # Main Lambda handler with session management
├── Makefile                  # make and release the package as zip file to be used and deployed by terraform
└── package.json              # Node.js dependencies (includes S3 SDK & zip)

```

## Prerequisites

- AWS CLI configured with appropriate permissions
- Docker installed and running (for local testing)
- Node.js 20

## Deployment

This project is deployed automatically through CI/CD in the pytorch-gha-infra repository. The infrastructure is managed as code in that repository, including:

- AWS Lambda function with VPC access
- AWS Fargate cluster and services for MCP containers
- S3 bucket with 30-day lifecycle policy for session storage
- ECR repositories for Docker image builds
- VPC networking and security configurations

### Local Development

To develop and test locally:

```bash
# Install dependencies
yarn install

# Run tests
yarn test

# Build the Lambda package
make deployment.zip
```

## Session Management Details

### S3 Structure

```
s3://grafana-mcp-sessions-{random}/
└── sessions/
    ├── user-123-456-789/
    │   └── session.zip        # Contains .claude folder contents
    ├── user-abc-def-ghi/
    │   └── session.zip
    └── ...
```

### Lambda Environment

- **Working Directory**: `/tmp` (Lambda requirement)
- **Claude Storage**: `/tmp/.claude` (automatically managed)
- **Session Lifecycle**: Download → Process → Upload → Cleanup

### Automatic Features

- **30-Day Retention**: S3 lifecycle policy automatically deletes old sessions
- **Encryption**: Sessions encrypted at rest in S3
- **Versioning**: S3 versioning enabled for session recovery
- **Cross-Contamination Prevention**: Each request gets isolated temp directory

## Available MCP Tools

### Grafana Tools

- `mcp__grafana-mcp__get_dashboard`
- `mcp__grafana-mcp__create_dashboard`
- `mcp__grafana-mcp__update_dashboard`
- `mcp__grafana-mcp__list_datasources`
- `mcp__grafana-mcp__create_datasource`

### ClickHouse Tools

- `mcp__clickhouse-pip__run_clickhouse_query`
- `mcp__clickhouse-pip__get_clickhouse_schema`
- `mcp__clickhouse-pip__get_clickhouse_tables`
- `mcp__clickhouse-pip__explain_clickhouse_query`
- And more...

## Frontend Integration Example

```javascript
// Example frontend integration
async function sendQuery(query, userUuid) {
  const response = await fetch(LAMBDA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: query,
      userUuid: userUuid, // Required for session management
    }),
  });

  // Handle streaming response
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    console.log("Received:", chunk);
    // Update UI with streaming response
  }
}

// Usage
const userUuid = "user-" + crypto.randomUUID();
sendQuery("Create a CPU usage dashboard", userUuid);
```

## Monitoring

### Check S3 Sessions

```bash
aws s3 ls s3://grafana-mcp-sessions-*/sessions/ --recursive
```

### Check Lambda Logs

```bash
aws logs tail /aws/lambda/grafana-mcp-lambda --follow
```

### Check Fargate Status

```bash
aws ecs list-services --cluster grafana-mcp-cluster --region us-east-1
aws ecs describe-services --cluster grafana-mcp-cluster --services grafana-mcp clickhouse-mcp --region us-east-1
```

## Troubleshooting

### Common Issues

1. **Session not persisting**

   - Check S3 bucket permissions
   - Verify userUuid is being passed correctly
   - Check Lambda logs for S3 errors

2. **Lambda timeout on large sessions**

   - Increase Lambda timeout (current: 15 minutes)
   - Consider session compression optimization

3. **MCP containers not responding**
   - Check Fargate service status
   - Verify networking between Lambda and Fargate containers
   - Check CloudWatch logs for container issues

### Debug Commands

```bash
# Check specific user session
aws s3 cp s3://grafana-mcp-sessions-*/sessions/user-123/session.zip ./debug-session.zip
unzip -l debug-session.zip

# Test Lambda directly
aws lambda invoke --function-name grafana-mcp-lambda \
  --payload '{"body": "{\"query\": \"test\", \"userUuid\": \"test-user\"}"}' \
  response.json
```

## Security Features

- **Encryption**: All session data encrypted at rest
- **Access Control**: IAM policies restrict S3 access to Lambda only
- **Network Isolation**: VPC security groups isolate Fargate container communication
- **Session Isolation**: Each user has completely isolated session storage
