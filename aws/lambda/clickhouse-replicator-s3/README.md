This lambda is used to replicate the change data capture (CDC) records from s3
buckets tables to their corresponding ClickHouse ones. This is done by listening
to the stream of `INSERT` and `REMOVE` events coming to the DynamoDB tables and
inserting them into ClickHouse

### Deployment

A new version of the lambda can be deployed using `make deploy` and it
is done so automatically as part of the CI in `.github/workflows/clickhouse-replicator-s3-lambda.yml`.
