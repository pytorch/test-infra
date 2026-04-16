This lambda is used to ingest ServiceLab benchmark results from
ossci-benchmarks S3 bucket into servicelab_torch_dynamo_perf_stats
ClickHouse table. The result is in CSV format and is immutable, so the
lambda doesn't need to handle any updates or deletes.

### Deployment

A new version of the lambda can be deployed using `make deploy` and it
is done so automatically as part of the CI.
