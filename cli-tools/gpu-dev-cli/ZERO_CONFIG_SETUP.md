# Zero-Config GPU Dev CLI Setup

## Installation & Usage

**1. Install the CLI:**

```bash
cd cli-tools/gpu-dev-cli
pip install -e .
```

**2. Ensure AWS credentials are configured:**

```bash
# Your AWS credentials should already be set via:
export AWS_REGION=us-east-2  # (optional - defaults to us-east-2)
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, or AWS profiles
```

**3. Just start using it - zero config needed!**

```bash
# Reserve GPUs
gpu-dev reserve --gpus 2 --hours 4

# Check status
gpu-dev status

# List your reservations
gpu-dev list

# Show auto-discovered config
gpu-dev config

```

## How It Works

**Zero Configuration:**

- Auto-discovers AWS resources by naming convention
- Queue: `pytorch-gpu-dev-reservation-queue`
- Tables: `pytorch-gpu-dev-reservations`, `pytorch-gpu-dev-servers`
- Cluster: `pytorch-gpu-dev-cluster`
- Region: `AWS_REGION` env var or defaults to `us-east-2`

**Authentication:**

- Uses your existing AWS credentials
- If you can access the SQS/DynamoDB resources → you're authorized
- No GitHub tokens, no config files, no manual setup

## Required AWS Permissions

Create an IAM role with the minimal policy in `minimal-iam-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:GetQueueUrl",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:*:*:pytorch-gpu-dev-reservation-queue"
    },
    {
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"],
      "Resource": [
        "arn:aws:dynamodb:*:*:table/pytorch-gpu-dev-reservations*",
        "arn:aws:dynamodb:*:*:table/pytorch-gpu-dev-servers"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    }
  ]
}
```

That's it! No more environment variables, config files, or GitHub tokens needed.
