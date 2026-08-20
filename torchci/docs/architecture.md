# `torchci` architecture notes

## Primary write path

How does data get from GitHub to `torchci`?

```mermaid
---
title: torchci write path
---
flowchart LR
   pytorchbot[Github App
   PyTorchBot] --> vercel@{ shape: das, label: "vercel
   /api/github/webhooks" }
   vercel --> dynamodb[DynamoDB
   torchci-* tables]
   dynamodb --> replicatorlambda@{ shape: das, label: "AWS Lambda
   clickhouse-replicator-dynamo"}
   replicatorlambda --> ClickHouse
```

Whenever something happens on GitHub, a [webhook event] is created and sent to
all subscribers. The [webhook payload] will contain all the necessary
information about the event. For example, if a new issue is created, an
[`issues`] webhook is generated, providing information about the issue title,
who created the issue, etc.

[GitHub Apps] can subscribe to webhooks for the repos that they're installed
on. `torchci` uses the [PyTorch Bot] app to keep track of what's going on in
`pytorch/pytorch` and any other repos it's installed on.

These webhooks are delivered to an API endpoint on [hud.pytorch.org]
([`/api/github/webhooks`]), which writes the webhook payload to a DynamoDB
table corresponding to the event type. For example, `workflow_job` payloads are
written to `torchci-workflow-job`.

ClickHouse [ingests from DynamoDB using an AWS Lambda][ch_dynamo] to automatically pick up
changes in the tables.

[webhook event]: https://docs.github.com/en/developers/webhooks-and-events/webhooks/about-webhooks
[webhook payload]: https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads
[`issues`]: https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#issues
[github apps]: https://docs.github.com/en/developers/apps/getting-started-with-apps/about-apps
[pytorch bot]: https://github.com/apps/pytorch-bot
[`/api/github/webhooks`]: https://github.com/pytorch/test-infra/blob/main/torchci/pages/api/github/webhooks.ts
[ch_dynamo]: https://github.com/pytorch/test-infra/tree/6abfc539d0ce7daf0fcd07533de37b8723e6454a/aws/lambda/clickhouse-replicator-dynamo

## Secondary write paths

There are some parts to the system that don't use the write path described
above, because GitHub doesn't generate webhooks for them.

Notably, this means that **installing the PyTorch Bot app to repos will not
enable these write paths**. They must be manually wired up.

### Build artifacts

Our build jobs create various artifacts that we want to save to persistent
storage and use later. For example, most of our build jobs produce binary wheel
distributions of PyTorch that are later downloaded by our test jobs.

These are uploaded to S3 directly by the GitHub workflows in `pytorch/pytorch`.

### Logs and log classifications

The PyTorch bot's `workflow_job` handler (`lib/bot/logUploader.ts`) asynchronously
invokes the [`gha-log-uploader`] lambda when a job completes. That lambda
downloads the log from GitHub and puts it in the [`ossci-raw-job-status`] bucket
under `log/`. An S3 `ObjectCreated` notification on that prefix then invokes
`call-log-classifier`, which invokes [`log-classifier`] to do the classification
(more detail in the [README]).

[readme]: https://github.com/pytorch/test-infra/blob/main/aws/lambda/log-classifier/README.md

Because this hangs off the App webhook rather than a per-repo one, every repo the
bot is installed on gets log downloads and classifications without an admin
configuring anything. Which repos are enabled is controlled by the
`LOG_UPLOADER_REPOS` env var while the cutover from [`github-status-test`] is in
progress; see https://github.com/pytorch/test-infra/issues/7549.

Missing logs are re-requested through `backfillMissingLog` in `lib/jobUtils.ts`,
which Dr.CI calls when it finds a failed job with no log. Callers outside HUD use
the authenticated `POST /api/log-uploader/backfill` route.

### Test statistics

See the [README](https://github.com/pytorch/pytorch/tree/master/tools/stats).

### CircleCI results

CircleCI also has webhooks like GitHub, but they must be configured manually.
The webhooks are delivered to the [`ossci-circleci-to-s3`] lambda, which is
synced to Rockset. See the [example config] for `pytorch/vision` webhooks for
an example.

[`ossci-circleci-to-s3`]: https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/ossci-circleci-to-s3?tab=code
[example config]: https://app.circleci.com/settings/project/github/pytorch/vision/webhooks/a5ae92ec-d523-4495-be2a-58ab80a255b9?return-to=https%3A%2F%2Fapp.circleci.com%2Fpipelines%2Fgithub%2Fpytorch%2Fvision

### Raw webhook payloads

The [`github-status-test`] lambda archives raw webhook payloads to the
[`ossci-raw-job-status`] S3 bucket, under a prefix per event type. Nothing reads
them: `clickhouse-replicator-s3` has no `SUPPORTED_PATHS` entry for
`workflow_job/`, `workflow_run/`, or `full_workflow_*/`, and ClickHouse gets jobs
from DynamoDB through `clickhouse-replicator-dynamo`.

This archive goes away with the lambda. It is not reproduced in
[`gha-log-uploader`].

[`github-status-test`]: https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/github-status-test?tab=code
[`gha-log-uploader`]: https://github.com/pytorch/test-infra/blob/main/aws/lambda/gha-log-uploader/README.md
[`ossci-raw-job-status`]: https://s3.console.aws.amazon.com/s3/buckets/ossci-raw-job-status?region=us-east-1&tab=overview

## Adding a new repo to `torchci`

To get the basic HUD working, you will need to:

1. Install the PyTorch Bot app to the repo. This requires admin access to the
   `pytorch` org. To find someone with admin access, consult the [Build/CI POCs].
2. Configure CircleCI to send webhooks to `torchci` (see above). This requires
   admin access to CircleCI. (**NOTE**: Only required if running CircleCI workflows)

You won't get any of the other goodies listed in "Secondary write paths" above,
but other than that, things should work!

[build/ci pocs]: https://pytorch.org/docs/master/community/persons_of_interest.html#build-ci
