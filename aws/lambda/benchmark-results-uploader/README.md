# Benchmark Results Uploader

This AWS Lambda function uploads benchmark result files to S3 buckets with authentication.

## Functionality

This Lambda:

1. Accepts S3 bucket name, path, and content of a file
2. Authenticates the request using username/password from environment variables 
3. Checks if the specified path already exists in the S3 bucket
4. If the path doesn't exist, uploads the content to that path
5. Returns appropriate HTTP status codes and messages

## Input Parameters

The Lambda expects the following input parameters in the event object:

- `username`: Username for authentication
- `password`: Password for authentication
- `bucket_name`: Name of the S3 bucket
- `path`: Path within the bucket where content will be stored
- `content`: The content to upload

## Environment Variables

The Lambda requires two environment variables:

- `AUTH_USERNAME`: Username for authentication
- `AUTH_PASSWORD`: Password for authentication

## Deployment

To deploy the Lambda function:

```bash
make deploy
```

This will:
1. Install dependencies
2. Package the Lambda function
3. Deploy to AWS

## Testing

To test the Lambda function locally:

```bash
# Setup environment variables
export AUTH_USERNAME=your_username
export AUTH_PASSWORD=your_password

# Run test
python test_lambda_function.py
```
