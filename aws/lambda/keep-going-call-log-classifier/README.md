# Keep Going Call Log Classifier

This is a simple AWS Lambda function that uploads the temporary values for
keep-going in DynamoDB and ClickHouse by calling the log classifier when a new
object is added to `s3://gha-artifacts/temp_logs`.

Please see https://github.com/pytorch/pytorch/pull/155371 for more context.

## Testing

To test the Lambda function locally:

```bash
# Run test
python test_lambda_function.py
```

Page maintainers: @pytorch/pytorch-dev-infra
Last verified: 2025-06-24
