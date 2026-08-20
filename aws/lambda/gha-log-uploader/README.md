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

After a log is stored, `log_classifier` is called through its function URL —
byte for byte the call `github-status-test` makes today.

That call is synchronous. Function URLs only support the `RequestResponse`
invocation type, so this function's duration includes the classification, and
`github-status-test`'s 274s/344s/400s/900s duration maxima come from exactly
this. **Keep the timeout at 900s**: on a slow classification a shorter one would
kill the invocation mid-wait, and since callers invoke asynchronously, Lambda
would then retry the whole thing and re-download the log.

Unlike in `github-status-test` the tail is no longer harmful. There it ran behind
API Gateway on the webhook's critical path, so a slow classification risked a
GitHub webhook timeout. Here the caller has already returned, and a long
invocation costs GB-seconds and a concurrency slot, nothing more.

The way out is `lambda:InvokeFunction` with `InvocationType: "Event"`, which
needs `log_classifier` to accept a plain `{"job_id", "repo"}` payload — it
currently only parses the API Gateway request its `lambda_http` handler expects.
That change also lets its `AuthType: NONE` function URL be retired, once
`backfillJobs.mjs`, `keep-going-call-log-classifier` and `github-status-test`
move off it. Worth doing on its own, not as a rider on this migration.

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

1. Create the function: python3.12, x86_64, handler `lambda_function.lambda_handler`,
   512 MB, **900s timeout** — matching `github-status-test`, because the
   synchronous classifier call means a slow classification is a slow invocation.
2. Give its execution role `s3:PutObject` on `arn:aws:s3:::ossci-raw-job-status/log/*`
   plus the usual CloudWatch Logs permissions. No `lambda:InvokeFunction` is
   needed while the classifier is reached over its function URL.
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
7. Nothing to wire for classification: the classifier is called over its existing
   function URL, so there is no notification or extra permission to add.

## Deployment

`make deploy` publishes to `$LATEST` and is live immediately; the deploy job in
`.github/workflows/gha-log-uploader-lambda.yml` runs it on every push to main that
touches this directory. `make prepare` verifies the zip contains every vendored
module and `make deploy` refuses to publish a package built for a different python
than the function runs, but there is no staged rollout behind either.

`PYTHON_VERSION` in the Makefile must match the function's runtime. Changing one
without the other breaks every invocation.
