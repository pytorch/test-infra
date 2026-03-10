# cross_repo_ci_relay

Two AWS Lambda functions that relay GitHub webhook events from the upstream repository to downstream repositories, and write CI results to ClickHouse.

Splitting into two functions keeps webhook processing and result ingestion isolated, which simplifies log analysis and CloudWatch alarming.

For more information, please refer to this [RFC](https://github.com/pytorch/pytorch/issues/175022).

## Environment Variables

### `cross_repo_ci_webhook`

| Variable | Description | Example |
|----------|-------------|---------|
| `GITHUB_APP_ID` | GitHub App ID | `2847493` |
| `SECRET_STORE_ARN` | AWS Secrets Manager secret ARN for sensitive config | `arn:aws:secretsmanager:us-east-1:123456789012:secret:cross-repo-ci-relay/app-secrets-xxxxxx` |
| `UPSTREAM_REPO` | Upstream repository (`owner/repo`) | `pytorch/pytorch` |
| `WHITELIST_URL` | GitHub blob URL to whitelist YAML | `https://github.com/<owner>/<repo>/blob/<ref>/whitelist.yaml` |
| `WHITELIST_TTL_SECONDS` | Whitelist cache TTL in Redis (seconds) | `3600` |
| `LOG_LEVEL` | Logging level | `INFO` |

The webhook Lambda does not read `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY`, or `REDIS_URL` from environment variables. Those values are loaded only from the Secrets Manager secret addressed by `SECRET_STORE_ARN`.

### `cross_repo_ci_result`

| Variable | Description | Example |
|----------|-------------|---------|
| `WHITELIST_URL` | GitHub blob URL to whitelist YAML | `https://github.com/<owner>/<repo>/blob/<ref>/whitelist.yaml` |
| `CLICKHOUSE_URL` | ClickHouse HTTP endpoint | `http://1.2.3.4:0000` |
| `CLICKHOUSE_USER` | ClickHouse username | `admin` |
| `CLICKHOUSE_DATABASE` | ClickHouse database | `default` |
| `SECRET_STORE_ARN` | AWS Secrets Manager secret ARN for sensitive config | `arn:aws:secretsmanager:us-east-1:123456789012:secret:cross-repo-ci-relay/app-secrets-xxxxxx` |
| `WHITELIST_TTL_SECONDS` | Whitelist cache TTL in Redis (seconds) | `3600` |
| `LOG_LEVEL` | Logging level | `INFO` |

The result Lambda does not read `CLICKHOUSE_PASSWORD` or `REDIS_URL` from environment variables. Those values are loaded only from the Secrets Manager secret addressed by `SECRET_STORE_ARN`.

`POST /ci/result` must include an `Authorization: Bearer <token>` header. The token must be a GitHub Actions OIDC token issued by `https://token.actions.githubusercontent.com`.

The token `repository` claim must also match the repository encoded in the submitted run URL.

Each verified bearer token is hashed and stored in Redis under the prefix `oot:result_token:` until the token's own `exp` time, so the same token cannot be reused within its validity window. The whitelist cache remains stored at `oot:whitelist_yaml`.

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
