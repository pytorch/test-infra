# call-log-classifier

Triggers log classification when a job log lands in
`s3://ossci-raw-job-status/log/`. Wired to `s3:ObjectCreated:*` on that prefix, so
whatever wrote the log — `gha-log-uploader`, torchci's backfill route, or a person
running `aws s3 cp` — gets it classified.

This exists so uploading and classifying are decoupled. `github-status-test`
called the classifier inline with an untimed `urlopen` and blocked until it
finished, which is what produced its 274s/344s/400s/900s duration tails.

## Key shapes

| Key | Repo |
| --- | --- |
| `log/<job_id>` | `pytorch/pytorch` (unprefixed for historical reasons) |
| `log/<owner>/<repo>/<job_id>` | `<owner>/<repo>` |

Anything else is skipped and logged. `log/<owner>/<job_id>` in particular cannot be
attributed to a repo, so it is ignored rather than guessed at.

## Why it does not use the classifier's function URL

`log_classifier` has a Lambda function URL with `AuthType: NONE`. This function
reaches it through `lambda:InvokeFunction` instead, so the path from S3 to
classification never crosses a public endpoint.

`log_classifier` is built on `lambda_http` with only the `apigw_http` feature, so
it expects an API Gateway HTTP API v2.0 request. `classifier_payload()` reproduces
that shape. Verified against the deployed function: a payload with no `job_id`
returns its 400 `no job id provided` branch, and one with a non-numeric `job_id`
fails inside its `parse::<usize>()` — together showing that both the envelope and
the query string are read from a direct invoke.

The invoke is asynchronous. Classification can take minutes and nothing here reads
the result.

## Relationship to keep-going-call-log-classifier

`keep-going-call-log-classifier` does the same job for the `temp_logs/` prefix on
`gha-artifacts`, and still calls the classifier over its public function URL. It
is deliberately left alone during the `github-status-test` cutover. Folding the
two together, and then removing the public function URL, is cleanup for
afterwards.

## One-time AWS setup

1. Create the function: python3.12, handler `lambda_function.lambda_handler`. Only
   boto3 is imported, so the package is just the handler.
2. Give its execution role `lambda:InvokeFunction` on
   `arn:aws:lambda:us-east-1:308535385114:function:log_classifier`, plus the usual
   CloudWatch Logs permissions.
3. Let S3 invoke it:
   ```
   aws lambda add-permission --function-name call-log-classifier \
     --statement-id s3-ossci-raw-job-status --action lambda:InvokeFunction \
     --principal s3.amazonaws.com \
     --source-arn arn:aws:s3:::ossci-raw-job-status \
     --source-account 308535385114
   ```
4. Add an `s3:ObjectCreated:*` notification on `ossci-raw-job-status` filtered to
   prefix `log/`. **Read the existing configuration and add to it** —
   `put-bucket-notification-configuration` replaces the whole document, and that
   bucket already carries twelve `clickhouse-replicator-s3` rules that must
   survive. None of them overlap `log/`.

Do not enable the notification before `gha-log-uploader` is live, or every log the
old lambda writes gets classified twice.
