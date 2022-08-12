# log classifier

The log classifier is a Python script that runs and:

1. Downloads a log file from S3.
2. Classifies it, according to rules defined in `rules.json`.
3. Uploads the classification back to S3.

It can be run locally (see `python classify_log.py --help`), but is mostly run
by AWS Lambda (called `ossci-log-analyzer` in PyTorch's AWS account).

## How to add a new rule

Edit `pages/api/classifier/rules.ts` to add a rule. This rule will be deployed
along with the main app, so once your changes are pushed in `main` and the
corresponding Vercel deployment completes, the lambda will automatically pick up
the rule.

## How to backfill a new rule

Run `backfill.py`. Note that this uses the Lambda to run the rules, so you need
to make sure [the live site](https://www.torch-ci.com/api/classifier/rules)
reflects your changes before you run!

## Why do we classify every log (including succeeding logs) but only backfill failing ones?

Before Aug 12, 2022, the AWS lambda only classified failing jobs, because many of the log classifications are only relevant for failed jobs. However, after flaky tests started to be shielded from CI, CI now shows as "passing" even when it contained flakiness. To better equip developers in debugging these instances, we want to classify flaky tests as well, so we now classify all logs (and not only failing ones).

However, we DON'T want to backfill succeeding jobs, as they often do not match any classification line (and if they do, it's usually because of an expected failure). Backfilling currently attempts to classify the most recent 1000 unclassified logs. Since succeeding jobs often have no classification, backfilling will not be able to tell that those jobs have already been classified and will attempt to re-classify these jobs.