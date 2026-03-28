# Cross Repo CI Relay

An AWS Lambda function that relays GitHub webhook events from the upstream repository to downstream repositories.

For more information, please refer to this [RFC](https://github.com/pytorch/pytorch/issues/175022).

## Overall Mechanism

This service receives webhook events from an upstream GitHub repository and acts as a relay for cross-repository CI signaling.

When a supported pull request event is received, the function validates the request, determines whether the event should be processed, and then resolves the downstream repositories that should receive the relay.

Those downstream targets are defined through an allowlist file which is pointed by a url (set with `ALLOWLIST_URL` and should be hosted as a GitHub blob, e.g. `https://github.com/pytorch/pytorch/blob/main/.github/allowlist.yaml`), whose format is described below.


```yaml
L1:
  - org1/repo1
  - org2/repo2
L2:
  - org3/repo3
L3:
  - org4/repo4
L4:
  - org5/repo5: oncall1, oncall2
```

All levels (L1–L4) are dispatched to. Dispatch targets are the union of all repositories across every level.

Each entry is either a plain `owner/repo` string or a `owner/repo: oncall1, oncall2` mapping. Duplicate repositories across levels are not allowed.

The allowlist is cached in Redis under the key `crcr:allowlist_yaml` with a TTL controlled by `ALLOWLIST_TTL_SECONDS`. On a Redis error the function falls back to fetching directly from GitHub.

## Build and Deploy

### Make Targets

Build the Lambda zip (output: deployment.zip)
```bash
make deployment.zip
```

Deploy to AWS Lambda (requires AWS CLI v2 configured with permissions)
```bash
make deploy AWS_REGION=us-east-1 FUNCTION_NAME=cross_repo_ci_webhook
```

Clean build artifacts
```bash
make clean
```
