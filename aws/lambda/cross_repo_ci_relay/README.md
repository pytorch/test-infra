# cross_repo_ci_relay

Two AWS Lambda functions that relay GitHub webhook events from the upstream repository to downstream repositories, and write CI results to ClickHouse.

Splitting into two functions keeps webhook processing and result ingestion isolated, which simplifies log analysis and CloudWatch alarming.

For more information, please refer to this [RFC](https://github.com/pytorch/pytorch/issues/175022).

## Environment Variables

### `cross_repo_ci_webhook`

| Variable | Description | Example |
|----------|-------------|---------|
| `GITHUB_APP_ID` | GitHub App ID | `1234567` |
| `SECRET_STORE_ARN` | AWS Secrets Manager secret ARN for sensitive config | `arn:aws:secretsmanager:us-east-1:123456789012:secret:cross-repo-ci-relay/app-secrets-xxxxxx` |
| `REDIS_ENDPOINT` | Redis endpoint hostname; preferred over `REDIS_URL` when set | `my-cache.xxxxxx.use1.cache.amazonaws.com` |
| `REDIS_LOGIN` | Redis login in `username:password` format paired with `REDIS_ENDPOINT` | `relay-user:relay-password` |
| `UPSTREAM_REPO` | Upstream repository (`owner/repo`) | `pytorch/pytorch` |
| `WHITELIST_URL` | GitHub blob URL to whitelist YAML | `https://github.com/<owner>/<repo>/blob/<ref>/whitelist.yaml` |
| `WHITELIST_TTL_SECONDS` | Whitelist cache TTL in Redis (seconds) | `3600` |
| `IN_PROGRESS_WORKFLOW_TTL_SECONDS` | Max lifetime for in-progress workflow and pending-close Redis records (seconds) | `10800` |
| `LOG_LEVEL` | Logging level | `INFO` |

When `REDIS_ENDPOINT` is set, the webhook Lambda builds the Redis connection from `REDIS_ENDPOINT` and optional `REDIS_LOGIN`. Otherwise it falls back to `REDIS_URL`, which may still come from the Secrets Manager secret addressed by `SECRET_STORE_ARN`.

### `cross_repo_ci_result`

| Variable | Description | Example |
|----------|-------------|---------|
| `GITHUB_APP_ID` | GitHub App ID used to cancel delayed workflow runs | `1234567` |
| `WHITELIST_URL` | GitHub blob URL to whitelist YAML | `https://github.com/<owner>/<repo>/blob/<ref>/whitelist.yaml` |
| `CLICKHOUSE_URL` | ClickHouse HTTP endpoint | `http://1.2.3.4:0000` |
| `CLICKHOUSE_USER` | ClickHouse username | `admin` |
| `CLICKHOUSE_DATABASE` | ClickHouse database | `default` |
| `SECRET_STORE_ARN` | AWS Secrets Manager secret ARN for sensitive config | `arn:aws:secretsmanager:us-east-1:123456789012:secret:cross-repo-ci-relay/app-secrets-xxxxxx` |
| `REDIS_ENDPOINT` | Redis endpoint hostname; preferred over `REDIS_URL` when set | `my-cache.xxxxxx.use1.cache.amazonaws.com` |
| `REDIS_LOGIN` | Redis login in `username:password` format paired with `REDIS_ENDPOINT` | `relay-user:relay-password` |
| `WHITELIST_TTL_SECONDS` | Whitelist cache TTL in Redis (seconds) | `3600` |
| `IN_PROGRESS_WORKFLOW_TTL_SECONDS` | Max lifetime for in-progress workflow and pending-close Redis records (seconds) | `10800` |
| `LOG_LEVEL` | Logging level | `INFO` |

When `REDIS_ENDPOINT` is set, the result Lambda builds the Redis connection from `REDIS_ENDPOINT` and optional `REDIS_LOGIN`. Otherwise it falls back to `REDIS_URL`, which may still come from the Secrets Manager secret addressed by `SECRET_STORE_ARN`.

`POST /ci/result` must include an `Authorization: Bearer <token>` header. The token must be a GitHub Actions OIDC token issued by `https://token.actions.githubusercontent.com`.

For local development, create a `.env` file — `config.py` loads it automatically via `python-dotenv`.

## Build and Deploy

### Make Targets

```bash
# Build both zips
make prepare

# Build only one
make prepare-webhook
make prepare-result

# Deploy both (build + aws lambda update-function-code)
make deploy

# Deploy only one
make deploy-webhook
make deploy-result

# Clean build artifacts
make clean
```

`make deploy-webhook` is equivalent to:

```bash
make prepare-webhook
aws lambda update-function-code --function-name cross_repo_ci_webhook --zip-file fileb://webhook/deployment.zip
```
