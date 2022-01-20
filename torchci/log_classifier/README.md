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
