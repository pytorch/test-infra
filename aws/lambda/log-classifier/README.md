# Log classifier

The log classifier:

1. Downloads a log file from S3.
2. Classifies it, according to rules defined in `ruleset.toml`.
3. Uploads the classification to DynamoDB, mutating the `torchci-workflow-job`
   table, which in turn populates the `workflow_job` collection in Rockset.

It is written in a natively compiled language for efficiency/tail latency
reasons (there was a Python implementation at one point which had quite bad tail
latency characteristics, which make it challenging to run in a serverless
environment).

It is deployed as an AWS Lambda function called `[log-classifier]`.

## How to add a new rule

Edit the ruleset in `ruleset.toml` to add a rule (see that file for guidelines
on how to write rules). This rule will be deployed along with the main app, so
once your changes are pushed in `main` and the corresponding Vercel deployment
completes, the new rule should be in effect.

## Testing the lambda locally

Unit tests can be run by running `cargo test`.

If you want to actually test invoking the lambda, you can use [`cargo-lambda`].

```
cargo lambda watch
cargo lambda invoke --data-file=fixtures/request.json
```

You can edit `fixtures/request.json` to test different inputs.

**Note that this will write to S3!** You can pass a different value for
`ShouldWriteS3` if you don't want to do that.

## Lambda deployment

The lambda is deployed from main (see:
`.github/workflows/log-classifier-lambda.yml`).

## Why mutate the the `workflow_job` collection instead of creating a separate one for classifications?

We used to do this. Queries get a lot slower (~5x) when you have to perform a
big join between `workflow_job` and the classifications table. Mutations are
handled transparently by Rockset, so there is no real disadvantage to doing
this.

[`log-classifier`]: https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/log_classifier?tab=monitoring
[`cargo-lambda`]: https://www.cargo-lambda.info/
