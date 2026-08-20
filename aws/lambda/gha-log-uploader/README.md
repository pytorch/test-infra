# gha-log-uploader

Downloads a completed GitHub Actions job log and archives it to
`s3://ossci-raw-job-status/log/`. This is the log-download half of the old
`github-status-test` lambda, moved behind the PyTorch bot so onboarding a repo to
HUD no longer needs an admin to add a repo webhook. See
https://github.com/pytorch/test-infra/issues/7549.

`github-status-test` still exists and is untouched. It is deleted after the
cutover, not edited into this shape.

## How it is invoked

Only through `lambda:InvokeFunction`. **There is no API Gateway integration and no
function URL, and neither should be added** — the function must not be reachable
from the internet.

Two callers, both in torchci, both using `InvocationType: "Event"`:

- `lib/bot/logUploader.ts`, on a `workflow_job` webhook with `action == completed`.
- `lib/jobUtils.ts`'s `backfillMissingLog`, when Dr.CI notices a log is missing.
  External callers reach the same path through the authenticated
  `POST /api/log-uploader/backfill` route.

Payload:

```json
{ "repo": "pytorch/executorch", "job_id": 12345, "conclusion": "failure" }
```

`conclusion` is optional. A malformed payload raises, which means Lambda retries
twice and then DLQs it.

## Classification

After a log is stored, `log_classifier` is invoked with `InvocationType: "Event"`
and the result is not awaited. `github-status-test` called it with an untimed
`urlopen` and blocked until classification finished, which is what produced its
274s/344s/400s/900s duration tails — the fix is the invocation type, not a
separate function.

It is reached through `lambda:InvokeFunction` rather than its public function URL
(`AuthType: NONE`), so the path from here to classification never crosses a
public endpoint. `log_classifier` builds on `lambda_http` with only the
`apigw_http` feature, so `classifier_payload()` reproduces an API Gateway HTTP API
v2.0 request. Verified against the deployed function: a payload with no `job_id`
returns its 400 "no job id provided" branch, and a non-numeric one fails inside
its `parse::<usize>()`, which together show both the envelope and the query
string are read from a direct invoke.

A failed handoff is logged and reported as `classified: false`, not raised.
Raising would make Lambda retry the whole function, re-downloading a
multi-megabyte log from GitHub to retry something that takes milliseconds; the
log itself is already safe in S3.

## What it does not do

It does not archive raw webhook payloads. Nothing read them —
`clickhouse-replicator-s3` has no `SUPPORTED_PATHS` entry for `workflow_job/`,
`workflow_run/`, or `full_workflow_*/`, and ClickHouse gets jobs from DynamoDB via
`clickhouse-replicator-dynamo`.

## S3 key scheme

`log/<job_id>` for `pytorch/pytorch`, `log/<owner>/<repo>/<job_id>` for everything
else. The asymmetry is historical but load-bearing: the `log_url` ALIAS in
`clickhouse_db_schema/default.workflow_job/schema.sql` derives URLs from exactly
this shape, so changing it silently breaks every log link in the HUD.

## GitHub credentials

Job logs are downloaded with a GitHub App installation token, falling back to the
`GITHUB_TOKENS` PAT pool when the app is rate limited, rejected, or not installed
on the repo.

| Env var | Required | Purpose |
| --- | --- | --- |
| `GITHUB_APP_ID` | no | App id used to mint installation tokens (e.g. `4550824`, `pytorch-bot-preview`) |
| `GITHUB_APP_PRIVATE_KEY` | no | The app's private key, base64-encoded PEM (same encoding torchci uses) |
| `GITHUB_TOKENS` | yes | Comma-separated PAT pool, used as the fallback and when no app is configured |

With both app vars unset the function only uses `GITHUB_TOKENS`, so the app can be
rolled back by clearing the env vars — no code change or redeploy needed.

Notes on the app path:

- Installation tokens last an hour and are cached per repo in module scope, so a
  warm invocation reuses one rather than minting a token per job.
- The app's rate limit is per installation. `pytorch` is enterprise-owned, so its
  installation gets 15,000 requests/hour, independent of any other app's quota.
  Use a dedicated app rather than the shared `pytorch-bot` installation, whose
  quota Dr. CI and the HUD already draw on.
- Repos outside the installation (e.g. `vllm-project/vllm`) resolve to no
  installation and go straight to the PAT pool; that negative result is cached
  briefly to avoid a lookup per job.
- Downloading job logs is documented as needing `actions: read`. It currently
  works without it because pytorch repos are public, but the permission should be
  granted before any private repo is onboarded.

## One-time AWS setup

Not done by CI. Needed before the deploy workflow can run.

1. Create the function: python3.12, x86_64, handler `lambda_function.lambda_handler`.
   512 MB and a 60s timeout are plenty — the old function averaged 200ms and its
   long tail was the classifier ping this one does not make.
2. Give its execution role `s3:PutObject` on `arn:aws:s3:::ossci-raw-job-status/log/*`,
   `lambda:InvokeFunction` on
   `arn:aws:lambda:us-east-1:308535385114:function:log_classifier`, plus the
   usual CloudWatch Logs permissions.
3. Set the env vars above. Prefer fresh credentials over copying
   `github-status-test`'s, whose PATs sit in plaintext env vars and are due for
   rotation.
4. Configure an on-failure destination or DLQ, and alarm on it. That queue is the
   only signal that a trunk-only job lost its log.
5. Add the invoke grant for torchci, and nothing else:
   ```
   aws lambda add-permission --function-name gha-log-uploader \
     --statement-id torchci-invoke --action lambda:InvokeFunction \
     --principal arn:aws:iam::308535385114:user/pytorch_hud_bot
   ```
   Confirm that user really is the principal behind torchci's
   `OUR_AWS_ACCESS_KEY_ID` before granting.
6. Create the `gha_workflow_gha-log-uploader-lambda` IAM role the deploy workflow
   assumes, mirroring `gha_workflow_github-status-test-lambda`.
7. Nothing to wire for classification: this function invokes `log_classifier`
   directly, so there is no S3 notification to add. `keep-going-call-log-classifier`
   still covers the separate `temp_logs/` prefix on `gha-artifacts`.

## Deployment

`make deploy` publishes to `$LATEST` and is live immediately; the deploy job in
`.github/workflows/gha-log-uploader-lambda.yml` runs it on every push to main that
touches this directory. `make prepare` verifies the zip contains every vendored
module and `make deploy` refuses to publish a package built for a different python
than the function runs, but there is no staged rollout behind either.

`PYTHON_VERSION` in the Makefile must match the function's runtime. Changing one
without the other breaks every invocation.
