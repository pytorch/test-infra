This lambda ingests test run reports (`torchci-reports/**/*.report.jsonl` in
gha-artifacts) into ClickHouse in batches. An EventBridge rule queues one SQS
message per report, and the lambda runs `clickhouse-replicator-s3`'s report SQL
once per batch. The queue and event source mapping are in pytorch-gha-infra's
`torchci_reports_batch.tf`.

### Deployment

A new version of the lambda can be deployed using `make deploy` and it
is done so automatically as part of the CI in `.github/workflows/torchci-reports-batch-ingest-lambda.yml`.
