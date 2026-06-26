# Cross Repo CI Relay

An AWS Lambda function that relays GitHub webhook events from the upstream repository to downstream repositories, and forwards downstream CI results to HUD.

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

## Reporting Results from Downstream CI

L2+ downstream repositories can report the status of their CI workflows back to the relay server using the [`cross-repo-ci-relay-callback`](../../../.github/actions/cross-repo-ci-relay-callback/action.yml) composite action.

### Security and the Relay/HUD boundary

The callback endpoint validates incoming callbacks and forwards them to HUD for persistence. The relay is the gatekeeper for OIDC authentication, allowlist checks, rate limiting, and schema validation — HUD just authenticates the relay and writes what it's told.

#### Relay's responsibilities:

- **Identity**: the `Authorization: Bearer <oidc-token>` header is verified against GitHub's JWKS.  The OIDC `repository` claim is a trusted identity for the caller and is used for the L2+ allowlist check. Relay forwards this trusted value to HUD as a top-level `verified_repo` field; HUD should prefer it over anything self-reported in `callback_payload`.
- **Repo level**: Relay determines the downstream repository's allowlist level (L1–L4) and forwards it to HUD as `downstream_repo_level`. This authoritative level information is determined once by the relay, ensuring HUD doesn't need to recompute it and avoiding synchronization/timing issues if tiering information becomes dynamic.
- **Schema validation**: Relay validates that required fields (`delivery_id` and `workflow.status`) are present in the callback body.  Missing fields result in a `400` error to signal contract violations to the caller.  HUD receives validated data and does not need to perform schema checks.
- **State machine**: Relay maintains a **unified state machine** in Redis to validate callback lifecycles, compute timing metrics, and support per-workflow tracking:
  - **Unified structure**: Single enum `CallbackState` with states `DISPATCHED` (webhook side, keyed by sentinel `run_id=0, run_attempt=0`), `IN_PROGRESS`, and `COMPLETED` (callback side, per-workflow). State records stored as JSON: `{"state": "...", "timestamp": 1234.56}`.
  - **Dispatch validation**: `DISPATCHED` state proves valid webhook origin. Callbacks without this state are rejected (no prior dispatch).
  - **Workflow-level tracking**: Each workflow has independent state and timestamps keyed by `{run_id}:{run_attempt}` (`crcr:state:{delivery_id}:{repo}:{run_id}:{run_attempt}`). Supports multiple workflows per webhook.
  - **Timing metrics**: `queue_time = dispatch_timestamp → in_progress_timestamp`, `execution_time = in_progress_timestamp → completed_timestamp`. Timestamps extracted from state records.
  - **State transitions**: Rejects invalid flows (`COMPLETED` without prior `IN_PROGRESS`, duplicate `IN_PROGRESS` for the same `{run_id}:{run_attempt}`, duplicate `COMPLETED`, callbacks without a prior `DISPATCHED` record).
    Note that the direction graph below is for a single check run, reruns have different `run_attempt` and are treated as separate workflows, so they won't violate the state machine since they won't have a prior `IN_PROGRESS` or `COMPLETED` record.
    ```mermaid
    stateDiagram-v2
        direction LR

        [*] --> DISPATCHED: webhook sends
        DISPATCHED --> IN_PROGRESS: first callback
        IN_PROGRESS --> COMPLETED: completion

        IN_PROGRESS --> IN_PROGRESS: ❌ duplicate
        DISPATCHED --> COMPLETED: ❌ skip IN_PROGRESS
        COMPLETED --> COMPLETED: ❌ duplicate
        COMPLETED --> IN_PROGRESS: ❌ wrong direction
        [*] --> IN_PROGRESS: ❌ no dispatch
        [*] --> COMPLETED: ❌ no dispatch
    ```

The HUD request looks like (two top-level namespaces: `trusted` and `untrusted`):

```json
{
  "trusted": {
    "ci_metrics": { "queue_time": 1.23, "execution_time": null },
    "verified_repo": "org/repo",
    "downstream_repo_level": "L2"
  },
  "untrusted": {
    "callback_payload": {
      "event_type": "pull_request",
      "delivery_id": "<github X-GitHub-Delivery>",
      "payload": { ...original upstream webhook payload, verbatim... },
      "workflow": {
        "schema_version": 1,
        "status": "completed",
        "conclusion": "success",
        "name": "CI",
        "url": "https://github.com/org/repo/actions/runs/123",
        "job_name": "my-ci-job",
        "started_at": "2026-05-04T20:48:28Z", // when status == in_progress, else None
        "completed_at": "2026-05-04T21:23:45Z", // when status == completed, else None
        "test_results": { "passed": 42, "failed": 3, "skipped": 5 },
        "artifact_url": "https://github.com/org/repo/actions/runs/123/artifacts"
      }
    }
  }
}
```

Notes:
- `trusted` contains relay-generated fields the HUD can rely on (`ci_metrics`, `verified_repo`, and `downstream_repo_level`).
- `untrusted.callback_payload` contains the downstream-reported callback body; HUD should treat it as untrusted and prefer `trusted.verified_repo` for identity.

Trust boundaries inside `untrusted.callback_payload`:

- `untrusted.callback_payload.payload` is the upstream webhook payload, transparently forwarded —
  trusted at dispatch time, but not re-verified on the callback.
- `untrusted.callback_payload.workflow` is **self-reported by the downstream CI** and is not
  authenticated.  Only `verified_repo` carries a cryptographic identity.

### Error propagation back to the downstream workflow

| HUD response | Relay behaviour | Effect on downstream CI step |
|---|---|---|
| `2xx` | record delivered | green |
| `4xx` (schema reject) | propagate same status | **red** — author must fix payload |
| `5xx` / network error | log + return | green — HUD outage is not the caller's fault |

The asymmetry is deliberate: `4xx` means the caller sent something wrong and should see it; `5xx`/network means HUD or its infrastructure is broken and should not be surfaced as a red CI step across every L2+ repo. Operators are expected to alert on the `HUD forward failed` CloudWatch log pattern.

#### Known limitations of this model

A compromised or malicious maintainer of an allowlisted repo can:

1. Fabricate `workflow.status` / `workflow.conclusion` values for upstream PRs their repo was never dispatched for — HUD will receive the row, but `verified_repo` always identifies the true caller.
2. Replay an older dispatched payload against the callback endpoint — there is no dispatch-side nonce.
3. Tamper with any field inside `callback_payload` — HUD must trust `verified_repo`, not the others.

All three attacks are **scoped to the attacker's own OIDC-authenticated repo identity** — OIDC guarantees they cannot impersonate another allowlisted repo. Mitigation is operational: every HUD row carries `verified_repo`, so misbehaviour is observable, and the offending repo can be removed from `allowlist.yaml`.

### Prerequisites

- The downstream repository must be listed at level **L2 or higher** in the allowlist.
- The **calling job** must declare `permissions: id-token: write` so that the action can mint a GitHub OIDC token for authentication.

### Usage

When triggered by a relay `repository_dispatch`, the action automatically reads `github.event.client_payload` for `delivery_id` and the upstream webhook payload, and reads `github.workflow` / the current run URL for the workflow identity.  Workflow authors only required to pass `status` (and `conclusion` when `status=completed`, others are optional).

```yaml
on:
  repository_dispatch:
    types: [pull_request]

jobs:
  my-ci-job:
    runs-on: ubuntu-latest
    permissions:
      id-token: write   # required for OIDC token minting
      contents: read
    steps:
      - name: Report in-progress to relay
        uses: pytorch/test-infra/.github/actions/cross-repo-ci-relay-callback@main
        with:
          status: in_progress

      # ... your CI steps ...

      - name: Report final result to relay
        if: always()
        uses: pytorch/test-infra/.github/actions/cross-repo-ci-relay-callback@main
        with:
          status: completed
          conclusion: ${{ job.status }}
```

### Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `status` | **yes** | — | `in_progress` or `completed` |
| `conclusion` | no | `''` | Passed through to the check run as-is (typically `${{ job.status }}`); required when `status=completed` and must be a value GitHub accepts (e.g. `success`, `failure`, `cancelled`) |
| `test-results` | no | `''` | Optional JSON string with test result summary (counts: passed/failed/skipped) |
| `callback-url` | **yes** | — | Callback endpoint URL (production Lambda URL; set once at the workflow level) |
| `artifact-url` | no | `''` | URL to downstream-hosted artifacts (logs, reports, results) |

## Build, Deploy, and Test

### Deployment layout

The build packages each Lambda as a zip that preserves the package hierarchy:

```
deployment/
├── webhook/
│   ├── lambda_function.py
│   └── event_handler.py
├── callback/
│   ├── lambda_function.py
│   └── callback_handler.py
└── utils/
    └── ...
```

This matches the layout used during local development and tests, so imports behave identically in both environments.  Configure the AWS Lambda handlers as:

- Webhook Lambda: `webhook.lambda_function.lambda_handler`
- Callback Lambda: `callback.lambda_function.lambda_handler`

### Make Targets

Build the Webhook Lambda zip (output: `webhook/deployment.zip`):

```bash
cd webhook
make deployment.zip
```

Build the Callback Lambda zip (output: `callback/deployment.zip`):

```bash
cd callback
make deployment.zip
```

Deploy both zips to AWS Lambda (requires AWS CLI v2 with permissions):

```bash
make deploy AWS_REGION=us-east-1 \
    WEBHOOK_FUNCTION_NAME=cross_repo_ci_webhook \
    CALLBACK_FUNCTION_NAME=cross_repo_ci_callback
```

Either side can be deployed independently:

```bash
make deploy-webhook
make deploy-callback
```

Run all unit tests under `tests/`:

```bash
make test
```

Clean build artifacts:

```bash
make clean
```

## Local Development

`local_server.py` wraps both Lambda handlers in a FastAPI app so you can test the full cross-repo-ci-relay flow without deploying to AWS.

### Prerequisites

#### Local

- Python 3.13
- A running Redis instance:
  ```bash
  # Using the built-in "default" user with a password:
  docker run -d --name crcr-redis \
    -p 6379:6379 \
    redis:7-alpine \
    redis-server --requirepass <your-password>
  ```
- [smee.io](https://smee.io) CLI to forward GitHub webhook events to localhost (paste this link to GitHub App webhook URL):
  ```bash
  npm install -g smee-client
  smee --url https://smee.io/<your-channel> --path /github/webhook --port 8000
  ```

  CLI to forward GitHub callback callbacks to localhost (set this URL as `callback-url` in the downstream workflow):
  ```bash
  npm install -g smee-client
  smee --url https://smee.io/<your-channel> --path /github/callback --port 8000
  ```

#### Remote

- GitHub App settings (refer to this [RFC](https://github.com/pytorch/pytorch/issues/175022))
- An allowlist YAML GitHub URL with the specific format (refer to the same RFC above)
- An Upstream repo and Downstream repos with GitHub App installed and allowlist configured

### Setup

1. Install dependencies:
   ```bash
   pip install -r requirements.txt fastapi uvicorn python-dotenv
   ```

2. Create a `.env` file in this directory:
   ```dotenv
   # GitHub App
   GITHUB_APP_ID=<app-id>
   GITHUB_APP_SECRET=<webhook-secret>
   GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
   <key content>
   -----END RSA PRIVATE KEY-----"

   # Relay
   UPSTREAM_REPO=<owner/repo>
   ALLOWLIST_URL=https://github.com/<owner>/<repo>/blob/main/allowlist.yaml
   MAX_DISPATCH_WORKERS=32

   # Redis (local, no TLS)
   REDIS_ENDPOINT=localhost:6379
   REDIS_LOGIN=default:<password>
   ALLOWLIST_TTL_SECONDS=1200

   # HUD (local testing)
    HUD_ENDPOINT=<your-local-testing-hud-endpoint>
   ```
   **Note**: `ALLOWLIST_URL` is required for local development and should point to a GitHub URL (it can differ from the production one).

3. Start the server:
   ```bash
   python3 local_server.py
   ```

4. Point your GitHub App's webhook URL to the smee.io channel, then open or update a pull request in the upstream repo to trigger a full relay cycle.

5. Check whether the workflow run status is reported back through `callback-url`.
